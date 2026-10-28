#!/usr/bin/env python3
"""
本地假 InstaBox API —— 给 keepalive.sh / worker.js 的自动化测试用。
不连真网、不用真 key：所有请求都由本进程应答。

场景由 --scenario 指定，配合 --expect 让 CI 直接断言脚本输出。

  python3 tools/mock_api.py --scenario running   --port 8897
  python3 tools/mock_api.py --scenario suspended --port 8897 --state-file /tmp/st.json

scenario:
  running    机器 running，续租直接成功
  suspended  机器 suspended，PUT 租约回 409；POST /resume 后转 running
  stopped    机器 stopped，PUT 回 409；POST /resume 回 409，POST /start 后转 running
  dead       永远不 running，resume/start 都回 409（测放弃路径）
  nolist     GET /v1/machines 返回空列表（测"这把 key 名下没有机器"）
  error      GET /v1/machines 返回 500（测报错路径）

--preset-snapshots 预置一批快照（逗号分隔名字，id 按 sn_0001 顺序生成），
配合 keepalive.sh --snapshot / worker /snapshot 测轮换裁剪逻辑。

请求日志同时写 stdout 和 --log 文件（一行一个 METHOD PATH STATUS），CI 用它断言。
"""
import argparse
import json
import sys
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE_LOCK = threading.Lock()
STATE = {}
ARGS = None


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def expires_at(ttl):
    return (datetime.now(timezone.utc) + timedelta(seconds=ttl)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def note(line):
    print(line, flush=True)
    if ARGS.log:
        with open(ARGS.log, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def current_state():
    """dead 场景永不转 running；其余按 --wake-polls 次 GET 后转 running。"""
    with STATE_LOCK:
        if STATE.get("polls", 0) > 0:
            STATE["polls"] -= 1
            return STATE["state"]
        if STATE.get("waking"):
            STATE["state"] = "running"
            STATE["waking"] = False
        return STATE["state"]


def machine_obj(mid, name):
    return {
        "id": mid,
        "name": name,
        "state": current_state(),
        "autoSuspendAfterSeconds": 1800,
        "autoSuspendedAt": None,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # 关掉默认 stderr 噪音
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    # ---- 路由 ----
    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/") or "/"
        key = self.headers.get("X-API-Key", "")
        if ARGS.require_key and not key:
            note(f"GET {path} 401")
            return self._send(401, {"error": {"code": "unauthenticated", "message": "no key"}})

        if path == "/v1/machines":
            if ARGS.scenario == "error":
                note(f"GET {path} 500")
                return self._send(500, {"error": {"code": "internal", "message": "boom"}})
            if ARGS.scenario == "nolist":
                note(f"GET {path} 200")
                return self._send(200, {"machines": []})
            note(f"GET {path} 200")
            return self._send(200, {"machines": [machine_obj(ARGS.machine_id, ARGS.machine_name)]})

        if path == "/v1/snapshots":
            with STATE_LOCK:
                snaps = list(STATE.get("snapshots", []))
            note(f"GET {path} 200")
            return self._send(200, {"snapshots": snaps})

        if path.startswith("/v1/machines/"):
            note(f"GET {path} 200")
            return self._send(200, machine_obj(ARGS.machine_id, ARGS.machine_name))

        note(f"GET {path} 404")
        return self._send(404, {"error": {"code": "not_found"}})

    def do_PUT(self):
        path = self.path.split("?")[0]
        body = self._body()
        ttl = int(body.get("ttlSeconds") or ARGS.ttl)
        if "/activity-leases/" in path:
            if current_state() != "running":
                note(f"PUT {path} 409")
                return self._send(
                    409,
                    {"error": {"code": "machine_not_running", "message": "machine is suspended; start it first"}},
                )
            note(f"PUT {path} 200")
            return self._send(200, {"lease": path.rsplit("/", 1)[-1], "expiresAt": expires_at(ttl)})
        note(f"PUT {path} 404")
        return self._send(404, {"error": {"code": "not_found"}})

    def do_DELETE(self):
        path = self.path.split("?")[0]
        if path.startswith("/v1/snapshots/"):
            sid = path.rsplit("/", 1)[-1]
            if not self.headers.get("Idempotency-Key"):
                note(f"DELETE {path} 400")
                return self._send(400, {"error": {"code": "bad_request", "message": "Idempotency-Key required"}})
            with STATE_LOCK:
                before = len(STATE.get("snapshots", []))
                STATE["snapshots"] = [s for s in STATE.get("snapshots", []) if s["id"] != sid]
                removed = before != len(STATE["snapshots"])
            note(f"DELETE {path} {'204' if removed else '404'}")
            return self._send(204, {}) if removed else self._send(404, {"error": {"code": "not_found"}})
        if "/activity-leases/" in path:
            note(f"DELETE {path} 204")
            return self._send(204, {})
        note(f"DELETE {path} 404")
        return self._send(404, {"error": {"code": "not_found"}})

    def do_POST(self):
        path = self.path.split("?")[0]
        if not self.headers.get("Idempotency-Key"):
            note(f"POST {path} 400")
            return self._send(400, {"error": {"code": "bad_request", "message": "Idempotency-Key required"}})

        if path.endswith("/snapshots"):
            body = self._body()
            name = (body.get("name") or "").strip()
            if not name:
                note(f"POST {path} 400")
                return self._send(400, {"error": {"code": "bad_request", "message": "name required"}})
            running = current_state() == "running"  # 先读状态再拿锁，current_state 里也要 STATE_LOCK，锁内再调会死锁
            with STATE_LOCK:
                if any(s["name"] == name for s in STATE.get("snapshots", [])):
                    note(f"POST {path} 409")
                    return self._send(409, {"error": {"code": "snapshot_name_taken", "message": name}})
                sn = {
                    "id": f"sn_{len(STATE.get('snapshots', [])) + 1:04d}",
                    "name": name,
                    "sourceMachineId": path.split("/")[3],
                    "status": "pending" if running else "ready",
                    "rootSizeBytes": 17179869184,
                    "dataSizeBytes": 21474836480,
                    "createdAt": now_iso(),
                }
                STATE.setdefault("snapshots", []).append(sn)
            code = 202 if sn["status"] == "pending" else 201
            note(f"POST {path} {code} name={name}")
            return self._send(code, sn)

        if path.endswith("/resume"):
            if ARGS.scenario in ("stopped", "dead"):
                note(f"POST {path} 409")
                return self._send(409, {"error": {"code": "operation_conflict", "message": "machine is stopped"}})
            with STATE_LOCK:
                STATE["waking"] = True
            note(f"POST {path} 202")
            return self._send(202, {"operation": {"id": "op_resume", "state": "queued"}})

        if path.endswith("/start"):
            if ARGS.scenario == "dead":
                note(f"POST {path} 409")
                return self._send(409, {"error": {"code": "operation_conflict", "message": "cannot start"}})
            with STATE_LOCK:
                STATE["waking"] = True
            note(f"POST {path} 202")
            return self._send(202, {"operation": {"id": "op_start", "state": "queued"}})

        note(f"POST {path} 404")
        return self._send(404, {"error": {"code": "not_found"}})


def main():
    global ARGS, STATE
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8897)
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--scenario", default="running",
                   choices=["running", "suspended", "stopped", "dead", "nolist", "error"])
    p.add_argument("--machine-id", default="m_test")
    p.add_argument("--machine-name", default="testbox")
    p.add_argument("--ttl", type=int, default=900)
    p.add_argument("--wake-polls", type=int, default=0,
                   help="唤醒后需要多少次 GET 才变 running（默认 0=下一次 GET 就是 running）")
    p.add_argument("--require-key", action="store_true", help="没带 X-API-Key 就 401")
    p.add_argument("--preset-snapshots", default="",
                   help="预置快照名（逗号分隔），如 ka-20261020-0800-x1,ka-20261021-2000-x1")
    p.add_argument("--log", default="")
    ARGS = p.parse_args()

    initial = {"suspended": "suspended", "stopped": "stopped", "dead": "suspended"}.get(ARGS.scenario, "running")
    STATE = {"state": initial, "waking": False, "polls": ARGS.wake_polls, "snapshots": []}
    for i, nm in enumerate([s.strip() for s in ARGS.preset_snapshots.split(",") if s.strip()], 1):
        STATE["snapshots"].append({
            "id": f"sn_{i:04d}",
            "name": nm,
            "sourceMachineId": ARGS.machine_id,
            "status": "ready",
            "rootSizeBytes": 17179869184,
            "dataSizeBytes": 21474836480,
            "createdAt": now_iso(),
        })

    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    # --port 0 表示让内核挑一个空闲端口，再把真实端口打出来给调用方读
    real_port = srv.server_address[1]
    note(f"MOCK listening on {ARGS.host}:{real_port} scenario={ARGS.scenario} initial={initial}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    sys.exit(main())
