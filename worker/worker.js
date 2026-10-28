// InstaBox keepalive on Cloudflare Workers — renews activity leases from a cron
// trigger, so no machine of your own has to stay up doing it.
//
// 单账号：只设 INSTABOX_API_KEY，可选 INSTABOX_MACHINE 指定机器。
// 多账号：第 N 个账号的变量名 = 单账号变量名 + _N，加一个账号就多加一个 Secret：
//
//   INSTABOX_API_KEY      1 号账号的 key（也可以写成 INSTABOX_API_KEY_1）
//   INSTABOX_API_KEY_2    2 号账号的 key
//   INSTABOX_API_KEY_3    3 号账号的 key ……
//
// 每个账号还可以单独覆盖 INSTABOX_MACHINE_2 / INSTABOX_LEASE_2 /
// INSTABOX_LEASE_TTL_2 / INSTABOX_AUTO_RESUME_2；不写就继承不带后缀的全局值。
// 同一把 key 配多次只续一次；编号可以不连续（只配 _2 也行）。
//
//   GET /                     所有账号各续租一次（手动触发，必写一条日志）
//   GET /status               所有账号的机器状态
//   GET /accounts             当前认到了哪些账号（key 打码）
//   GET /log                  最近 48 条保活日志（需要 KV 绑定 LOG）
//   GET /release              放掉租约
//   GET /snapshot             立即做一轮快照轮换（手动触发，不受时间窗限制）
//   GET /snapshots            列出各账号的快照（ka- 前缀的是轮换自动建的）
// 都要带 ?token=...（设了 TOKEN 变量时）；可加 &format=text 看纯文本；
// 加 &account=2 只操作 2 号账号（编号见 /accounts）。
//
// 变量 INSTABOX_LOG_MODE 控制写 KV 的频次（免费额度 1000 次写/天）：
//   hourly（默认）同一小时的连续成功只写 1 条 ≈24 次/天，失败立刻记
//   every  每次续租都写（*/9 = 160 次/天，仍在额度内）
//   off    完全不写 KV，/log 会是空的
//
// 机器被平台挂起（suspended）或停掉时，续租会 409 machine_not_running —— 此时光续租没用，
// 得先唤醒：自动 POST /resume（stopped 的用 /start 兜底）→ 等 running → 再续租。
// INSTABOX_AUTO_RESUME=0 可以关掉这个自愈。
//
// 快照轮换（INSTABOX_SNAPSHOT=1 开启，默认关）：cron 到了 INSTABOX_SNAPSHOT_HOURS
// （默认 1,13，按 INSTABOX_TZ 时区，默认 Asia/Shanghai）的小时点就做一轮：对每台机器
// 建 ka-YYYYMMDD-HHMM-<机器id后6位> 快照，并按「当天留 2、前 3 天各留 1」的 GFS 策略
// 裁剪 ka- 前缀旧快照（其它前缀的快照永不碰）；删到 ≤ 额度-1 再建，免费版 5 个也够。
const API_DEFAULT = "https://api.instabox.sh";
const LEASE_DEFAULT = "keepalive";
const TTL_DEFAULT = 300;
const SNAP_HOURS_DEFAULT = "1,13";
const TZ_DEFAULT = "Asia/Shanghai";
const SNAP_MAX_DEFAULT = 5;

function clampTtl(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 30 && n <= 3600 ? n : fallback;
}

function parseAutoResume(value, fallback) {
  if (!value) return fallback;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

// "1"/"true"/"on" → true，“0”/“false”/“off” → false，没给用默认
function parseOnOff(value, fallback) {
  if (value === undefined || String(value).trim() === "") return fallback;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

// "1,13" / "01, 13" → Set{1,13}
function parseHours(value) {
  const out = new Set();
  for (const part of String(value ?? "").split(",")) {
    const n = Number.parseInt(part.trim(), 10);
    if (Number.isInteger(n) && n >= 0 && n <= 23) out.add(n);
  }
  return out.size ? out : new Set([1, 13]);
}

function parseSnapMax(value) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 1 && n <= 50 ? n : SNAP_MAX_DEFAULT;
}

function cfg(env) {
  const base = {
    api: (env.INSTABOX_API_URL || API_DEFAULT).replace(/\/+$/, ""),
    lease: (env.INSTABOX_LEASE || LEASE_DEFAULT).trim() || LEASE_DEFAULT,
    ttl: clampTtl(env.INSTABOX_LEASE_TTL, TTL_DEFAULT),
    kv: env.LOG || null,
    // 被平台挂起后光续租没用，默认自愈：409 machine_not_running → resume/start → 再续租
    autoResume: parseAutoResume(env.INSTABOX_AUTO_RESUME ?? "1", true),
    // 快照轮换默认关；INSTABOX_SNAPSHOT=1（或某账号 INSTABOX_SNAPSHOT_2=1）打开
    snapshot: parseOnOff(env.INSTABOX_SNAPSHOT, false),
    // hourly（默认）：同一小时的“成功”不重复写 KV，省额度；every：每次都写；off：不写
    logMode: (env.INSTABOX_LOG_MODE || "hourly").trim(),
    // 快照轮换：默认关；开了以后到点自动建 ka- 快照并按 GFS 策略裁剪
    snapHours: parseHours(env.INSTABOX_SNAPSHOT_HOURS || SNAP_HOURS_DEFAULT),
    tz: (env.INSTABOX_TZ || TZ_DEFAULT).trim(),
    snapMax: parseSnapMax(env.INSTABOX_SNAPSHOT_MAX),
  };
  return { ...base, accounts: accountsOf(env, base) };
}

// "qqq" / "m_xxx,qqq" → ["m_xxx", "qqq"]；留空 = 该账号全部机器
function splitMachines(value) {
  if (value == null || value === "") return [];
  const arr = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

// 账号 N 的设置：带 _N 后缀的优先，其次是不带后缀的全局值，都没有就返回空（用内置默认）
function setting(env, name, n) {
  for (const key of [`INSTABOX_${name}_${n}`, `INSTABOX_${name}`]) {
    const value = env[key];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

// 从 env 里找出所有 INSTABOX_API_KEY / INSTABOX_API_KEY_2 / _3 ……，按编号排序。
// 单个变量里也能塞多把 key：INSTABOX_API_KEY="ibk_aaa,ibk_bbb"（逗号分隔）→
// 按顺序拆成 1 号、2 号账号。多余的 key 往后找空位；显式 _N 变量永远优先占自己的编号。
const KEY_RE = /^INSTABOX_API_KEY(?:_(\d+))?$/;

// 单值里的多把 key："ibk_aaa, ibk_bbb, ibk_ccc" → [ibk_aaa, ibk_bbb, ibk_ccc]
function splitKeys(value) {
  return String(value ?? "")
    .split(/,+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function accountKeys(env) {
  const byNumber = new Map();
  const explicit = new Set();
  // 第一遍：每个编号变量认领自己的编号（同一编号两把不同 key，不带后缀的优先）
  for (const [name, value] of Object.entries(env)) {
    const m = KEY_RE.exec(name);
    if (!m) continue;
    const key = String(value ?? "").trim();
    if (!key) continue;
    const n = m[1] ? Number.parseInt(m[1], 10) : 1;
    if (!Number.isSafeInteger(n) || n < 1) continue;
    explicit.add(n);
    const keys = splitKeys(value);
    const prev = byNumber.get(n);
    const entry = { key: keys[0], name, suffixed: !!m[1], origin: name };
    if (!prev) {
      byNumber.set(n, entry);
    } else {
      const winner = prev.suffixed && !entry.suffixed ? entry : prev;
      if (prev.key !== keys[0]) {
        console.warn(
          `instabox-keepalive: ${prev.origin} 和 ${name} 都是 ${n} 号账号但 key 不同，用 ${winner.origin}`,
        );
      }
      byNumber.set(n, winner);
    }
  }
  // 第二遍：把每个变量里逗号分隔的“第二把以后”的 key 外推到空编号；
  // 显式 _N 的编号永不被外推挤占（explicit 里有记录）
  for (const [name, value] of Object.entries(env)) {
    const m = KEY_RE.exec(name);
    if (!m) continue;
    const s = String(value ?? "").trim();
    if (!s) continue;
    const n = m[1] ? Number.parseInt(m[1], 10) : 1;
    if (!Number.isSafeInteger(n) || n < 1) continue;
    for (const k of splitKeys(s).slice(1)) {
      let e = n;
      while (byNumber.has(e) || explicit.has(e)) e += 1;
      byNumber.set(e, { key: k, name: `${name}#${e}`, suffixed: true, origin: `${name} 里第 ${e - n + 1} 把` });
    }
  }
  return [...byNumber.entries()].sort((a, b) => a[0] - b[0]);
}

// 账号列表：每个账号就是一套「单账号变量 + _N 后缀」
function accountsOf(env, base) {
  const accounts = [];
  for (const [n, { key }] of accountKeys(env)) {
    if (accounts.some((a) => a.key === key)) {
      console.warn(`instabox-keepalive: ${n} 号账号的 key 和前面的重复，已跳过`);
      continue;
    }
    accounts.push({
      account: n,
      key,
      machine: splitMachines(setting(env, "MACHINE", n)),
      lease: setting(env, "LEASE", n) || base.lease,
      ttl: clampTtl(setting(env, "LEASE_TTL", n), base.ttl),
      autoResume: parseAutoResume(setting(env, "AUTO_RESUME", n), base.autoResume),
      snapshot: parseOnOff(setting(env, "SNAPSHOT", n), base.snapshot),
      snapMax: base.snapMax,
      tz: base.tz,
      api: base.api,
    });
  }
  return accounts;
}

function pickAccounts(c, name) {
  if (!name) return c.accounts;
  const m = /^#?(\d+)$/.exec(name);
  if (!m) return [];
  const n = Number.parseInt(m[1], 10);
  return c.accounts.filter((a) => a.account === n);
}

function resolve(c, name) {
  if (!c.accounts.length) {
    return { error: "没配账号：加一个 INSTABOX_API_KEY（多账号再加 INSTABOX_API_KEY_2）" };
  }
  const picked = pickAccounts(c, name);
  if (!picked.length) {
    const have = c.accounts.map((a) => `#${a.account}`).join("、");
    return {
      error: /^#?\d+$/.test(name) ? `没有 ${name} 号账号；现在有 ${have}` : `?account= 要填账号编号，比如 2；现在有 ${have}`,
    };
  }
  return { picked };
}

async function call(c, method, path, body, idem) {
  const res = await fetch(c.api + path, {
    method,
    headers: {
      "X-API-Key": c.key,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(idem ? { "Idempotency-Key": idem } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

// 机器列表：填了名字/id 就那几台，留空=这把 key 名下全部（isolate 内按账号缓存 10 分钟）
const listCache = new Map();

async function machines(acc) {
  const cacheKey = `${acc.api}\n${acc.key}\n${acc.machine.join(",")}`;
  const hit = listCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 600_000) return hit.value;

  const list = [];
  const missing = [];
  let error = "";
  if (acc.machine.length) {
    for (const sel of acc.machine) {
      if (sel.startsWith("m_")) {
        list.push({ id: sel, name: sel, state: "" });
        continue;
      }
      const r = await call(acc, "GET", `/v1/machines/${encodeURIComponent(sel)}`);
      if (r.ok && r.json?.id) list.push({ id: r.json.id, name: r.json.name || sel, state: r.json.state || "" });
      else missing.push(sel);
    }
  } else {
    const r = await call(acc, "GET", "/v1/machines");
    if (r.ok) {
      for (const m of r.json?.machines || []) list.push({ id: m.id, name: m.name, state: m.state || "" });
    } else {
      error = `列机器失败：HTTP ${r.status} ${(r.text || "").slice(0, 160)}`;
    }
  }

  const value = { list, missing, error };
  if (!error && !missing.length) listCache.set(cacheKey, { value, at: Date.now() });
  return value;
}

// 保活日志：绑了 KV（变量名 LOG）就留最近 48 条，没绑也能用，只是 /log 空
// hourly 模式下同一小时的连续成功只写 1 次（KV 免费额度每天 1000 次写），失败照样立刻记
async function logEvent(c, entry, force) {
  if (!c.kv || c.logMode === "off") return;
  try {
    const arr = JSON.parse((await c.kv.get("log")) || "[]");
    const last = arr[0];
    if (!force && c.logMode === "hourly" && entry.ok && last && String(last.at).slice(0, 13) === entry.at.slice(0, 13)) {
      return;
    }
    arr.unshift(entry);
    await c.kv.put("log", JSON.stringify(arr.slice(0, 48)), {
      expirationTtl: 604800,
    });
  } catch (e) {
    console.log("instabox-keepalive: 写日志失败", e.message);
  }
}

const lease = (c, id) =>
  call(c, "PUT", `/v1/machines/${id}/activity-leases/${c.lease}`, { ttlSeconds: c.ttl });

// 409 machine_not_running：机器被平台挂起（suspended）或停掉了，续租对它是无效的
const isNotRunning = (r) =>
  r.status === 409 && /not_running|suspended|stopped/i.test(r.text || "");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// 换状态的写操作要 Idempotency-Key（缺了 400）；key 带时间戳，重试不会撞旧 key
async function act(c, id, type) {
  const res = await fetch(`${c.api}/v1/machines/${id}/${type}`, {
    method: "POST",
    headers: { "X-API-Key": c.key, "Idempotency-Key": `ka-${type}-${id}-${Date.now()}` },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function stateOf(c, id) {
  const r = await call(c, "GET", `/v1/machines/${id}`);
  return r.ok ? r.json?.state || "" : "";
}

// 唤醒一台机器：resume 优先，stopped 的用 start 兜底，轮询到 running 返回 wake 记录；没起来返回 null
async function wakeMachine(c, m) {
  const wake = [];
  for (const type of ["resume", "start"]) {
    const a = await act(c, m.id, type);
    wake.push(`${type}:${a.status}`);
    if (a.ok) break;
  }
  for (let i = 0; i < 3; i++) {
    await sleep(5000);
    if ((await stateOf(c, m.id)) === "running") return wake;
  }
  return null;
}

// 挂了就先唤醒再续租：running 后立刻续租一次
async function wakeThenLease(c, m) {
  const wake = await wakeMachine(c, m);
  if (wake === null) {
    return { ok: false, resumed: true, status: 409, error: "已发唤醒，机器还没 running（下一轮再续）", wake: [] };
  }
  const r = await lease(c, m.id);
  return r.ok
    ? { ok: true, resumed: true, expiresAt: r.json?.expiresAt, wake }
    : { ok: false, resumed: true, status: r.status, error: r.text.slice(0, 200), wake };
}

const noMachine = (acc) =>
  acc.machine.length ? `找不到机器 ${acc.machine.join("、")}（或 key 没权限）` : "这把 key 名下没有机器";

// 一个账号：把它的机器全部续一遍；单台失败不影响同账号其它机器
async function keepaliveAccount(acc) {
  const { list, missing, error } = await machines(acc);
  if (error) return { account: acc.account, lease: acc.lease, ttl: acc.ttl, ok: false, error, machines: [] };
  if (!list.length) {
    return { account: acc.account, lease: acc.lease, ttl: acc.ttl, ok: false, error: noMachine(acc), machines: [] };
  }

  const results = [];
  for (const m of list) {
    const base = { machine: m.name, id: m.id };
    try {
      const r = await lease(acc, m.id);
      if (r.ok) {
        results.push({ ...base, ok: true, expiresAt: r.json?.expiresAt });
      } else if (acc.autoResume && isNotRunning(r)) {
        // 被挂起了：续租是空转，先把它弄醒再续
        results.push({ ...base, ...(await wakeThenLease(acc, m)) });
      } else {
        results.push({ ...base, ok: false, status: r.status, error: r.text.slice(0, 200) });
      }
    } catch (e) {
      results.push({ ...base, ok: false, error: e.message });
    }
  }

  const out = {
    account: acc.account,
    lease: acc.lease,
    ttl: acc.ttl,
    ok: results.every((r) => r.ok) && !missing.length,
    machines: results,
  };
  if (missing.length) out.error = `找不到机器 ${missing.join("、")}`;
  return out;
}

const flatten = (accounts) => accounts.flatMap((a) => a.machines.map((m) => ({ account: a.account, ...m })));

async function keepalive(c, opts = {}) {
  const { picked, error } = resolve(c, opts.account);
  if (error) {
    return { ok: false, at: new Date().toISOString(), error, count: 0, accounts: [], machines: [] };
  }

  const accounts = [];
  for (const acc of picked) {
    try {
      accounts.push(await keepaliveAccount(acc));
    } catch (e) {
      // 一个账号的异常不能拖垮其它账号
      accounts.push({ account: acc.account, lease: acc.lease, ttl: acc.ttl, ok: false, error: `续租异常：${e.message}`, machines: [] });
    }
  }

  const flat = flatten(accounts);
  const out = {
    ok: accounts.length > 0 && accounts.every((a) => a.ok),
    at: new Date().toISOString(),
    count: flat.length,
    accounts: accounts.map((a) => ({
      account: a.account,
      ok: a.ok,
      count: a.machines.length,
      lease: a.lease,
      ttl: a.ttl,
      error: a.error,
    })),
    machines: flat,
  };
  await logEvent(c, out, opts.forceLog);
  return out;
}

async function status(c, account) {
  const { picked, error } = resolve(c, account);
  if (error) return { ok: false, error, count: 0, accounts: [], machines: [] };

  const accounts = [];
  for (const acc of picked) {
    try {
      const { list, missing, error: err } = await machines(acc);
      if (err) {
        accounts.push({ account: acc.account, ok: false, error: err, count: 0, machines: [] });
        continue;
      }
      const ms = [];
      for (const m of list) {
        const r = await call(acc, "GET", `/v1/machines/${m.id}`);
        ms.push(
          r.ok
            ? {
                machine: m.name,
                id: m.id,
                state: r.json?.state,
                autoSuspendAfterSeconds: r.json?.autoSuspendAfterSeconds,
                autoSuspendedAt: r.json?.autoSuspendedAt ?? null,
              }
            : { machine: m.name, id: m.id, error: `HTTP ${r.status}` },
        );
      }
      accounts.push({
        account: acc.account,
        ok: ms.length > 0 && !missing.length && ms.every((x) => !x.error),
        count: ms.length,
        error: missing.length ? `找不到机器 ${missing.join("、")}` : undefined,
        machines: ms,
      });
    } catch (e) {
      accounts.push({ account: acc.account, ok: false, error: `查询异常：${e.message}`, count: 0, machines: [] });
    }
  }

  const flat = flatten(accounts);
  return { ok: accounts.length > 0 && accounts.every((a) => a.ok), count: flat.length, accounts, machines: flat };
}

async function release(c, account) {
  const { picked, error } = resolve(c, account);
  if (error) return { ok: false, error, count: 0, accounts: [], machines: [] };

  const accounts = [];
  for (const acc of picked) {
    try {
      const { list, missing, error: err } = await machines(acc);
      if (err) {
        accounts.push({ account: acc.account, ok: false, error: err, count: 0, machines: [] });
        continue;
      }
      const ms = [];
      for (const m of list) {
        const r = await call(acc, "DELETE", `/v1/machines/${m.id}/activity-leases/${acc.lease}`);
        ms.push({ machine: m.name, id: m.id, ok: r.ok || r.status === 404, status: r.status });
      }
      accounts.push({
        account: acc.account,
        ok: ms.length > 0 && !missing.length && ms.every((x) => x.ok),
        count: ms.length,
        error: missing.length ? `找不到机器 ${missing.join("、")}` : undefined,
        machines: ms,
      });
    } catch (e) {
      accounts.push({ account: acc.account, ok: false, error: `释放异常：${e.message}`, count: 0, machines: [] });
    }
  }

  const flat = flatten(accounts);
  return { ok: accounts.length > 0 && accounts.every((a) => a.ok), count: flat.length, accounts, machines: flat };
}

function maskKey(key) {
  if (!key) return "";
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

// ---- 快照轮换 -----------------------------------------------------------------
// 时区感知的当前时间：{ ymd:"20261027", hour:20, minute:5 }；时区名不合法时 hour=-1
// （时间窗判定永远不命中，退化为只能手动 /snapshot）。
// 用 formatToParts 取字段值而不是 format() 的输出串：后者依赖 locale 格式，
// 在 small-icu 的 Node（如 alpine 的 musl 版）上 en-CA 会回退 en-US 变成 10/28/2026
function zonedParts(tz, at = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(at);
    const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
    const ymd = `${get("year")}${get("month")}${get("day")}`;
    return { ymd, hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
  } catch {
    return { ymd: "", hour: -1, minute: -1 };
  }
}

// "ka-20261027-0800-x1" → "20261027"；排序键就是整个名字（格式固定，字典序=时间序）
const snapYmd = (name) => name.slice(3, 11);

// GFS 裁剪：保留「今天≤2（即将建的是第 2 个，所以现有只留 1）+ 前 3 天各留最新 1 个」，
// 其余全删（含 ≤4 天前的和组内旧的）；删完若仍 ≥ 额度（keepMax）再从最老的删到
// keepMax-1 个，给新建的腾位。日期段不是 8 位数字的 ka- 视为残留，一并清理。
function planSnapshotPrune(items, dates, keepMax) {
  const inGroup = (d) => dates.includes(d);
  const sorted = [...items].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const latest = new Map(); // ymd → 组内最新
  for (const it of sorted) {
    const d = snapYmd(it.name || "");
    if (/^\d{8}$/.test(d) && inGroup(d)) latest.set(d, it);
  }
  const del = [];
  const keep = [];
  for (const it of sorted) {
    const d = snapYmd(it.name || "");
    ( /^\d{8}$/.test(d) && inGroup(d) && latest.get(d) === it ) ? keep.push(it) : del.push(it);
  }
  const extra = keep.length > keepMax - 1 ? keep.slice(0, keep.length - (keepMax - 1)) : [];
  return { del: [...del, ...extra].map((s) => s.id), kept: keep.length - extra.length };
}

// 一台机器建一个 ka-YYYYMMDD-HHMM-<机器id后6位>；同名已存在当成功（幂等），
// 额度被拒（429/409）就删最老的 ka- 腾位重试一次
async function snapshotOne(acc, m) {
  const p = zonedParts(acc.tz);
  if (!p.ymd) return { ok: false, error: `时区 ${acc.tz} 不合法` };
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  const name = `ka-${p.ymd}-${hh}${mm}-${m.id.replace(/^m_/, "").slice(-6)}`;
  const post = (suffix = "") =>
    call(acc, "POST", `/v1/machines/${m.id}/snapshots`, { name }, `ka-snap-${m.id}-${Date.now()}${suffix}`);
  let r = await post();
  if (r.ok) return { ok: true, name, status: r.status };
  if (r.status === 409 && /taken|exists|duplicate/i.test(r.text || "")) {
    return { ok: true, name, status: r.status, note: "同名快照已存在" };
  }
  // suspended/stopped 的机器不能快照（平台只收 running/stopped，冻结态一律 409）：
  // 像续租一样先唤醒再重试
  if (acc.autoResume && isNotRunning(r)) {
    const wake = await wakeMachine(acc, m);
    if (wake !== null) {
      r = await post("-r");
      if (r.ok) return { ok: true, name, status: r.status, note: "唤醒后成功", wake };
    }
  }
  // 只有额度/存储池被拒才腾位重试；机器状态冲突不在这类（上面已处理，别在这自删快照）
  if ((r.status === 429 || r.status === 409) && !isNotRunning(r)) {
    const list = await call(acc, "GET", "/v1/snapshots");
    if (list.ok) {
      const kas = (list.json?.snapshots || [])
        .filter((s) => /^ka-/.test(s.name || ""))
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      if (kas.length) {
        await call(acc, "DELETE", `/v1/snapshots/${kas[0].id}`, null, `ka-del-${kas[0].id}-${Date.now()}`);
        r = await post("-r2");
        if (r.ok) return { ok: true, name, status: r.status, note: "腾位后成功" };
      }
    }
  }
  return { ok: false, name, status: r.status, error: (r.text || "").slice(0, 160) };
}

// 一个账号一轮：裁剪旧 ka- 快照 → 对每台选中机器建新的
async function snapshotAccount(acc) {
  const out = { account: acc.account, ok: false, created: [], deleted: [], kept: 0 };
  const { list, missing, error } = await machines(acc);
  if (error || !list.length) {
    out.error = error || noMachine(acc);
    return out;
  }
  const r = await call(acc, "GET", "/v1/snapshots");
  if (!r.ok) {
    out.error = `列快照失败：HTTP ${r.status} ${(r.text || "").slice(0, 160)}`;
    return out;
  }
  const kas = (r.json?.snapshots || []).filter((s) => /^ka-/.test(s.name || ""));
  // 窗口 5 组：今天(建前只留 1，新的算第 2 个) + 前 4 天各留最新 1；
  // 窗口外/组内旧的删；删完仍 ≥ 额度的再从最老删到额度-1 腾位 ——
  // 早上那轮删的是「昨天 2 份中较旧的」，晚上那轮删的是「4 天前最老那份」。
  const dates = [0, 1, 2, 3, 4].map((n) => zonedParts(acc.tz, Date.now() - n * 86400000).ymd);
  const plan = planSnapshotPrune(kas, dates, acc.snapMax);
  for (const id of plan.del) {
    const d = await call(acc, "DELETE", `/v1/snapshots/${id}`, null, `ka-del-${id}-${Date.now()}`);
    if (d.ok || d.status === 404) out.deleted.push(id);
  }
  out.kept = plan.kept;
  const results = [];
  for (const m of list) results.push({ machine: m.name, ...(await snapshotOne(acc, m)) });
  out.machines = results;
  out.created = results.filter((x) => x.ok).map((x) => x.name);
  out.ok = results.every((x) => x.ok) && !missing.length;
  if (missing.length) out.error = `找不到机器 ${missing.join("、")}`;
  return out;
}

// 快照轮换（scheduled 到点或手动 /snapshot 都走这里）；ignoreSwitch=true 时
// 无视账号的 INSTABOX_SNAPSHOT 开关（手动触发 = 管理员明确要做）
async function rotateSnapshots(c, account, forceLog, ignoreSwitch = false) {
  const { picked, error } = resolve(c, account);
  if (error) return { ok: false, kind: "snapshot", at: new Date().toISOString(), error, count: 0, accounts: [] };

  const accounts = [];
  for (const acc of picked) {
    if (!acc.snapshot && !ignoreSwitch) {
      accounts.push({ account: acc.account, ok: true, skipped: "INSTABOX_SNAPSHOT 未开" });
      continue;
    }
    try {
      accounts.push(await snapshotAccount(acc));
    } catch (e) {
      accounts.push({ account: acc.account, ok: false, error: `快照异常：${e.message}` });
    }
  }
  const out = {
    ok: accounts.length > 0 && accounts.every((a) => a.ok),
    kind: "snapshot",
    at: new Date().toISOString(),
    count: accounts.reduce((n, a) => n + (a.created?.length || 0), 0),
    accounts,
  };
  const deleted = accounts.reduce((n, a) => n + (a.deleted?.length || 0), 0);
  await logEvent(c, { ...out, count: out.count, deleted }, forceLog);
  return out;
}

async function listSnapshots(c, account) {
  const { picked, error } = resolve(c, account);
  if (error) return { ok: false, error, accounts: [] };
  const accounts = [];
  for (const acc of picked) {
    try {
      const r = await call(acc, "GET", "/v1/snapshots");
      if (!r.ok) {
        accounts.push({ account: acc.account, ok: false, error: `HTTP ${r.status}` });
        continue;
      }
      accounts.push({
        account: acc.account,
        ok: true,
        snapshots: (r.json?.snapshots || []).map((s) => ({
          name: s.name,
          id: s.id,
          status: s.status,
          createdAt: s.createdAt,
          rotating: /^ka-/.test(s.name || ""),
        })),
      });
    } catch (e) {
      accounts.push({ account: acc.account, ok: false, error: e.message });
    }
  }
  return { ok: accounts.length > 0 && accounts.every((a) => a.ok), accounts };
}

function accountsView(c) {
  if (!c.accounts.length) return { ok: false, error: "没配账号：加一个 INSTABOX_API_KEY（多账号再加 INSTABOX_API_KEY_2）" };
  return {
    ok: true,
    count: c.accounts.length,
    accounts: c.accounts.map((a) => ({
      account: a.account,
      key: maskKey(a.key),
      machine: a.machine,
      lease: a.lease,
      ttl: a.ttl,
      autoResume: a.autoResume,
    })),
  };
}

export default {
  async scheduled(event, env) {
    const c = cfg(env);
    const out = await keepalive(c);
    if (out.ok) console.log("instabox-keepalive:", JSON.stringify(out));
    else console.error("instabox-keepalive:", JSON.stringify(out));

    // 快照轮换：到点（INSTABOX_SNAPSHOT_HOURS 的小时，按 INSTABOX_TZ）才跑；
    // */9 的 cron 每小时只有 :00 那轮满足 minute<9，天然防重；绑了 KV 的再靠
    // KV 标记补一次失败重试（:09/:18 那轮还能补上 :00 失败的）。
    const p = zonedParts(c.tz, event?.scheduledTime ?? Date.now());
    if (c.snapHours.has(p.hour)) {
      const stamp = `${p.ymd}${p.hour}`;
      const done = c.kv ? await c.kv.get("snap-done").catch(() => null) : null;
      if (p.minute < 9 || done !== stamp) {
        const r = await rotateSnapshots(c, undefined, false);
        if (r.ok && c.kv) await c.kv.put("snap-done", stamp).catch(() => {});
        if (!r.ok) console.error("instabox-keepalive snapshot:", JSON.stringify(r));
      }
    }
  },

  async fetch(request, env) {
    const c = cfg(env);
    const url = new URL(request.url);
    const asText = url.searchParams.get("format") === "text";
    if (env.TOKEN && url.searchParams.get("token") !== env.TOKEN) {
      return reply({ ok: false, error: "token 不对" }, 401, asText);
    }

    const route = url.pathname.replace(/\/+$/, "") || "/";
    const account = (url.searchParams.get("account") || "").trim();

    if (route === "/") {
      const out = await keepalive(c, { account, forceLog: true }); // 手动触发不给去重，一定出现在 /log
      return reply(out, out.ok ? 200 : 502, asText);
    }

    if (route === "/accounts") {
      const out = accountsView(c);
      return reply(out, out.ok ? 200 : 502, asText);
    }

    if (route === "/status") {
      const out = await status(c, account);
      return reply(out, out.ok ? 200 : 502, asText);
    }

    if (route === "/log") {
      const raw = c.kv ? await c.kv.get("log") : null;
      const entries = raw ? JSON.parse(raw) : [];
      return reply(
        {
          ok: true,
          storage: c.kv ? "KV 已绑定，保留最近 48 次（7 天）" : "未绑定 KV（变量 LOG），/log 为空",
          count: entries.length,
          entries,
        },
        200,
        asText,
      );
    }

    if (route === "/release") {
      const out = await release(c, account);
      return reply(out, out.ok ? 200 : 502, asText);
    }

    if (route === "/snapshot") {
      const out = await rotateSnapshots(c, account, true, true); // 手动 = 立即强制做一轮
      return reply(out, out.ok ? 200 : 502, asText);
    }

    if (route === "/snapshots") {
      const out = await listSnapshots(c, account);
      return reply(out, out.ok ? 200 : 502, asText);
    }

    return reply(
      { ok: false, error: "用 / 续租、/status 状态、/accounts 账号、/log 日志、/release 放租约、/snapshot 快照、/snapshots 快照列表" },
      404,
      asText,
    );
  },
};

function reply(body, status, asText) {
  if (asText) {
    const lines = [`ok=${body.ok}`];
    if (body.error) lines.push(`error=${body.error}`);
    for (const a of body.accounts || []) {
      if (a.key) {
        // /accounts
        lines.push(`[#${a.account}] ${a.key} ${(a.machine || []).join(",") || "全部机器"} lease=${a.lease} ttl=${a.ttl}`);
      } else if (a.snapshots) {
        // /snapshots
        lines.push(`[#${a.account}] ${a.ok ? `${a.snapshots.length} 个快照` : a.error}`);
        for (const s of a.snapshots) {
          lines.push(`  ${s.name} ${s.status || ""} ${s.createdAt || ""}${s.rotating ? " (轮换)" : ""}`);
        }
      } else if (a.created || a.deleted || a.kept !== undefined) {
        // /snapshot
        lines.push(
          `[#${a.account}] 快照 +${(a.created || []).length} -${(a.deleted || []).length} 留${a.kept ?? 0}` +
            (a.skipped ? ` 跳过：${a.skipped}` : a.ok ? " ok" : ` FAIL ${a.error || ""}`),
        );
        for (const n of a.created || []) lines.push(`  + ${n}`);
      } else if (a.error) {
        lines.push(`[#${a.account}] FAIL ${a.error}`);
      }
    }
    for (const m of body.machines || []) {
      const bad = m.ok === false || !!m.error;
      lines.push(
        [
          m.account !== undefined ? `[#${m.account}]` : "",
          m.machine || m.name,
          bad ? "FAIL" : "ok",
          m.expiresAt || m.state || m.status || "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    for (const e of body.entries || []) {
      lines.push(`${e.at} ok=${e.ok} ${e.kind === "snapshot" ? `快照 +${e.count} -${e.deleted ?? 0}` : `续租 ${e.count} 台`}`);
    }
    return new Response(lines.join("\n") + "\n", {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
