// InstaBox keepalive on Cloudflare Workers — renews an activity lease from a
// cron trigger, so no machine of your own has to stay up doing it.
//
//   npx wrangler secret put INSTABOX_API_KEY     # ibk_...  (never in wrangler.toml)
//   npx wrangler deploy
//
// Manual use (TOKEN is optional; set it to keep the URL non-public):
//   curl "https://instabox-keepalive.<you>.workers.dev/?token=..."            renew
//   curl "https://instabox-keepalive.<you>.workers.dev/status?token=..."      machine state
//   curl "https://instabox-keepalive.<you>.workers.dev/release?token=..."     drop the lease
//
// Vars: INSTABOX_API_URL, INSTABOX_MACHINE, INSTABOX_LEASE, INSTABOX_LEASE_TTL

const DEFAULT_API = "https://api.instabox.sh";
const DEFAULT_LEASE = "keepalive";
const DEFAULT_TTL = 300; // 30-3600

function cfg(env) {
  const ttl = Number.parseInt(env.INSTABOX_LEASE_TTL ?? DEFAULT_TTL, 10);
  const machine = (env.INSTABOX_MACHINE || "").trim();
  return {
    api: (env.INSTABOX_API_URL || DEFAULT_API).replace(/\/+$/, ""),
    key: env.INSTABOX_API_KEY || "",
    machine,
    lease: env.INSTABOX_LEASE || DEFAULT_LEASE,
    ttl: Number.isFinite(ttl) && ttl >= 30 && ttl <= 3600 ? ttl : DEFAULT_TTL,
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
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

// The lease routes take a machine id; a name works on GET /v1/machines/{id}, so
// a name is resolved once per isolate and cached for ten minutes.
let idCache = { name: "", id: "", at: 0 };

async function machineId(c) {
  if (c.machine.startsWith("m_")) return c.machine;
  const now = Date.now();
  if (idCache.name === c.machine && now - idCache.at < 600_000) return idCache.id;
  const r = await call(c, "GET", `/v1/machines/${c.machine}`);
  if (!r.ok || !r.json?.id) return null;
  idCache = { name: c.machine, id: r.json.id, at: now };
  return idCache.id;
}

const renew = (c, id) =>
  call(c, "PUT", `/v1/machines/${id}/activity-leases/${c.lease}`, {
    ttlSeconds: c.ttl,
  });

async function keepalive(c) {
  if (!c.key || !c.machine) {
    return { ok: false, error: "缺 INSTABOX_API_KEY 或 INSTABOX_MACHINE" };
  }
  const id = await machineId(c);
  if (!id) return { ok: false, error: `找不到机器 ${c.machine}（或这把 key 没权限）` };
  const r = await renew(c, id);
  if (!r.ok) {
    return { ok: false, error: `续租失败 HTTP ${r.status}`, body: r.text.slice(0, 500) };
  }
  return {
    ok: true,
    machine: c.machine,
    id,
    lease: c.lease,
    ttl: c.ttl,
    expiresAt: r.json?.expiresAt,
  };
}

export default {
  // Cron trigger (see wrangler.toml). Runs on Cloudflare, touches nothing local.
  async scheduled(_event, env, ctx) {
    const c = cfg(env);
    const out = await keepalive(c);
    if (!out.ok) console.error("instabox-keepalive:", out.error, out.body ?? "");
    else console.log("instabox-keepalive:", JSON.stringify(out));
    ctx.waitUntil(Promise.resolve());
  },

  async fetch(request, env) {
    const c = cfg(env);
    const url = new URL(request.url);
    if (env.TOKEN && url.searchParams.get("token") !== env.TOKEN) {
      return json({ ok: false, error: "token 不对" }, 401);
    }

    const action = url.pathname.replace(/\/+$/, "") || "/";
    if (action === "/") {
      const out = await keepalive(c);
      return json(out, out.ok ? 200 : 502);
    }
    if (action === "/status") {
      const r = await call(c, "GET", `/v1/machines/${c.machine}`);
      if (!r.ok) return json({ ok: false, error: `HTTP ${r.status}` }, 502);
      return json({
        ok: true,
        name: r.json?.name,
        state: r.json?.state,
        autoSuspendAfterSeconds: r.json?.autoSuspendAfterSeconds,
        autoSuspendedAt: r.json?.autoSuspendedAt ?? null,
      });
    }
    if (action === "/release") {
      const id = await machineId(c);
      if (!id) return json({ ok: false, error: `找不到机器 ${c.machine}` }, 502);
      const r = await call(c, "DELETE", `/v1/machines/${id}/activity-leases/${c.lease}`);
      const ok = r.ok || r.status === 404;
      return json({ ok, status: r.status }, ok ? 200 : 502);
    }
    return json({ ok: false, error: "用 / 续租、/status 看状态、/release 放租约" }, 404);
  },
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
