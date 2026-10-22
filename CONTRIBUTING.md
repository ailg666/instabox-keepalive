# Contributing

给要改代码的人（以及代写代码的 AI）看的规则。只想用的话看 [README](./README.md)，这里讲的是提交前必须满足的硬约束。

## 硬约束（违反直接拒 PR）

1. **`keepalive.sh` 必须是纯 POSIX sh**，只依赖 `curl`。不许引入 `bash` 专有语法（`[[ ]]`、数组、`local -n`、`${var^^}`、进程替换 `<(...)` 只允许出现在给用户的安装命令里，脚本内部不许用）、不许依赖 `jq`、`python`、`perl`、`awk` 的非 busybox 扩展。目标运行时是 **Alpine / BusyBox**。
2. **不用 `jq` 时靠 awk 降级**，降级分支必须同时吃得下两种 JSON 形态：紧凑（`{"machines":[`）和带空格（`"machines": [`，Python `json.dumps` 默认的形态），key 分隔符 `"k":"v"` 与 `"k": "v"` 都要认。新增任何 JSON 解析都必须两边都覆盖。
3. **Worker 侧零依赖**：`worker/worker.js` 只用 Workers 运行时自带的 API（`fetch`、KV binding、`cron`），不许引 npm 包，不许用 Node 专有模块。
4. **密钥绝不入库**。key、`TOKEN`、任何 `ibk_...` 都不许出现在代码、`wrangler.toml`、示例、日志里。脚本里打印 key 一律走已有的 `mask()`。
5. **不写回退/兜底式静默失败**。续租失败要如实报错退出，不许 `|| true` 吞掉，不许把失败包装成成功。

## 测试环境

改 `keepalive.sh` 前先把本地验证跑绿，不许只靠肉眼读 diff：

```sh
# 1. 语法（宿主 dash + 目标环境 busybox 双重校验）
sh -n keepalive.sh
docker run --rm -v "$PWD:/repo:ro" alpine:3.22 sh -n /repo/keepalive.sh

# 2. 真脚本端到端（不需要真 key，起本地假 API 即可）
#    假 API 至少要能模拟：正常续租、409 suspended、stopped(resume 被拒) 三个场景
docker run --rm --add-host=host.docker.internal:host-gateway \
  -e INSTABOX_API_URL=http://host.docker.internal:8897 \
  -e INSTABOX_API_KEY=ibk_dummy \
  -v "$PWD:/repo:ro" alpine:3.22 \
  sh -c 'apk add --no-cache -q curl >/dev/null && INSTABOX_ENV_FILE=/dev/null sh /repo/keepalive.sh --status'
```

- **基准容器固定 `alpine:3.22`**（NAT 机器实际跑的就是这版，busybox 1.37）。别的版本跑绿不算数。
- 测试**不许打真 API、不许用真 key**：所有用例对本地假服务（`http://127.0.0.1:PORT`）发请求，`INSTABOX_API_URL` 指过去即可。
- 测 `409` 自愈必须真的制造 409：假 API 先返回 `{"code":"machine_not_running"}`，`resume` 一次后才转 `running`，脚本要能 `resume → 等 running → 续租成功`；`stopped` 场景要能验证 `/start` 兜底。
- 改完贴出**实际命令输出**，不要写「应该没问题」。

## 改 Worker

- 改完 `worker/worker.js` 要同步检查 `worker/wrangler.toml` 的 `crons` 与 `INSTABOX_LEASE_TTL` 是否与线上一致 —— 仓库里的值一改，下次 CLI 部署就会把线上节奏改掉。
- 日志/结果字段只增不减：新增字段（如 `resumed`、`wake`）不许改掉已有字段名，`/log` 的既有消费者会挂。
- 涉及 KV 写的改动要算额度：免费版 1000 写/天，`hourly` 模式下一小时最多一条。

## PR 规范

- 一个 PR 只做一件事。
- 提交信息前缀：`feat:` / `fix:` / `docs:` / `refactor:` / `chore:`，正文说清**改了什么 + 为什么**，别写「优化代码」。
- 行为有变化时，**同步更新 README 对应章节**（新增 env 变量必须进 README 的变量表；多账号规则写在《多个账号》一节）。
- 改了用户可见行为，README 里示例命令要能**复制即跑**，不许留 `xxx` 省略号以外的假占位。
- 提 PR 前自查敏感信息：`grep -rniE "ibk_|secret|token|api[_-]?key" . --exclude-dir=.git`，确认没有真实凭据。

## 发版

- 主分支没有测试工作流，**发版闸门在 tag**：`git tag vX.Y.Z && git push origin vX.Y.Z` 前先把上面测试节跑绿。
- 版本号改动落在：README 开头的说明（如有）、`worker/wrangler.toml` 注释与 `keepalive.sh` 头部注释保持一致，不要只改一处。
