// InstaBox keepalive on Cloudflare Workers — renews activity leases from a cron
// trigger, so no machine of your own has to stay up doing it.
//
// Dashboard deploy (no CLI): Workers → Create → paste this file → Settings →
// Variables: INSTABOX_API_KEY (加密), TOKEN, INSTABOX_MACHINE (留空=全部机器) →
// Triggers → Cron: */4 * * * * → Deploy.
//
//   GET /                     续租一次（手动触发，必写一条日志）
//   GET /status               机器状态
//   GET /log                  最近 48 条保活日志（需要 KV 绑定 LOG）
//   GET /release              放掉租约
// 都要带 ?token=...（设了 TOKEN 变量时）；可加 &format=text 看纯文本。
//
// 变量 INSTABOX_LOG_MODE 控制写 KV 的频次（免费额度 1000 次写/天）：
//   hourly（默认）同一小时的连续成功只写 1 条 ≈24 次/天，失败立刻记
//   every  每次续租都写（*/9 = 160 次/天，仍在额度内）
//   off    完全不写 KV，/log 会是空的
const API_DEFAULT = "https://api.instabox.sh";
const LEASE_DEFAULT = "keepalive";
const TTL_DEFAULT = 300;

function cfg(env) {
  const ttl = Number.parseInt(env.INSTABOX_LEASE_TTL ?? TTL_DEFAULT, 10);
  return {
    api: (env.INSTABOX_API_URL || API_DEFAULT).replace(/\/+$/, ""),
    key: env.INSTABOX_API_KEY || "",
    machine: (env.INSTABOX_MACHINE || "").trim(),
    lease: env.INSTABOX_LEASE || LEASE_DEFAULT,
    ttl: Number.isFinite(ttl) && ttl >= 30 && ttl <= 3600 ? ttl : TTL_DEFAULT,
    kv: env.LOG || null,
    // hourly（默认）：同一小时的“成功”不重复写 KV，省额度；every：每次都写；off：不写
    logMode: (env.INSTABOX_LOG_MODE || "hourly").trim(),
  };
}

async function call(c, method, path, body) {
  const res = await fetch(c.api + path, {
    method,
    headers: {
      "X-API-Key": c.key,
      ...(body ? { "Content-Type": "application/json" } : {}),
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

// 机器列表：填了名字/id 就那一台，留空=这把 key 名下全部（isolate 内缓存 10 分钟）
let cache = { key: "", list: [], at: 0 };

async function machines(c) {
  const now = Date.now();
  if (cache.key === c.machine && now - cache.at < 600_000) return cache.list;
  let list = [];
  if (c.machine.startsWith("m_")) {
    list = [{ id: c.machine, name: c.machine }];
  } else if (c.machine) {
    const r = await call(c, "GET", `/v1/machines/${c.machine}`);
    if (r.ok && r.json?.id) list = [{ id: r.json.id, name: r.json.name || c.machine }];
  } else {
    const r = await call(c, "GET", "/v1/machines");
    if (r.ok) list = (r.json?.machines || []).map((m) => ({ id: m.id, name: m.name }));
  }
  cache = { key: c.machine, list, at: now };
  return list;
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

async function keepalive(c, forceLog) {
  if (!c.key) return { ok: false, error: "缺 INSTABOX_API_KEY" };
  const list = await machines(c);
  if (!list.length) {
    return {
      ok: false,
      error: c.machine ? `找不到机器 ${c.machine}（或 key 没权限）` : "这把 key 名下没有机器",
    };
  }
  const results = [];
  for (const m of list) {
    const r = await call(c, "PUT", `/v1/machines/${m.id}/activity-leases/${c.lease}`, {
      ttlSeconds: c.ttl,
    });
    results.push(
      r.ok
        ? { machine: m.name, id: m.id, ok: true, expiresAt: r.json?.expiresAt }
        : { machine: m.name, id: m.id, ok: false, status: r.status, error: r.text.slice(0, 200) },
    );
  }
  const out = {
    ok: results.every((r) => r.ok),
    at: new Date().toISOString(),
    lease: c.lease,
    ttl: c.ttl,
    count: results.length,
    machines: results,
  };
  await logEvent(c, out, forceLog);
  return out;
}

export default {
  async scheduled(_event, env, ctx) {
    const out = await keepalive(cfg(env));
    if (out.ok) console.log("instabox-keepalive:", JSON.stringify(out));
    else console.error("instabox-keepalive:", JSON.stringify(out));
    ctx.waitUntil(Promise.resolve());
  },

  async fetch(request, env) {
    const c = cfg(env);
    const url = new URL(request.url);
    const asText = url.searchParams.get("format") === "text";
    if (env.TOKEN && url.searchParams.get("token") !== env.TOKEN) {
      return reply({ ok: false, error: "token 不对" }, 401, asText);
    }

    const route = url.pathname.replace(/\/+$/, "") || "/";

    if (route === "/") {
      const out = await keepalive(c, true);   // 手动触发不给去重，一定出现在 /log
      return reply(out, out.ok ? 200 : 502, asText);
    }

    if (route === "/status") {
      if (!c.key) return reply({ ok: false, error: "缺 INSTABOX_API_KEY" }, 502, asText);
      const list = await machines(c);
      if (!list.length) return reply({ ok: false, error: "没有机器" }, 502, asText);
      const machinesOut = [];
      for (const m of list) {
        const r = await call(c, "GET", `/v1/machines/${m.id}`);
        machinesOut.push(
          r.ok
            ? {
                name: m.name,
                state: r.json?.state,
                autoSuspendAfterSeconds: r.json?.autoSuspendAfterSeconds,
                autoSuspendedAt: r.json?.autoSuspendedAt ?? null,
              }
            : { name: m.name, error: `HTTP ${r.status}` },
        );
      }
      return reply({ ok: true, count: machinesOut.length, machines: machinesOut }, 200, asText);
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
      const list = await machines(c);
      const out = [];
      for (const m of list) {
        const r = await call(c, "DELETE", `/v1/machines/${m.id}/activity-leases/${c.lease}`);
        out.push({ machine: m.name, ok: r.ok || r.status === 404, status: r.status });
      }
      const ok = out.length > 0 && out.every((r) => r.ok);
      return reply({ ok, machines: out }, ok ? 200 : 502, asText);
    }

    return reply(
      { ok: false, error: "用 / 续租、/status 状态、/log 日志、/release 放租约" },
      404,
      asText,
    );
  },
};

function reply(body, status, asText) {
  if (asText) {
    const lines = [`ok=${body.ok}`];
    if (body.error) lines.push(`error=${body.error}`);
    for (const m of body.machines || []) {
      lines.push(
        [m.machine || m.name, m.ok === false ? "FAIL" : "ok", m.expiresAt || m.state || m.status || ""]
          .filter(Boolean)
          .join(" "),
      );
    }
    for (const e of body.entries || []) {
      lines.push(`${e.at} ok=${e.ok} 续租 ${e.count} 台`);
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
