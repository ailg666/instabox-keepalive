# instabox-keepalive

[InstaBox](https://instabox.sh) 的机器空闲 30 分钟就会自动休眠（`auto-suspend`）。本仓库提供两种办法阻止它休眠：**首选——一次性关掉休眠机制；备用——activity lease 定期续租保活**。

## 首选：disable-sleep-mechanism.sh（一次性关掉休眠机制，跑一次就够了）

直接把机器自带的空闲自动挂起**永久关掉**（`autoSuspendAfterSeconds=0` → 服务端记为 `null`＝永不自动挂起）：

```sh
git clone https://github.com/pingmike2/instabox-keepalive
cd instabox-keepalive
INSTABOX_API_KEY=<你的key> ./disable-sleep-mechanism.sh    # 单次执行
```

- 用你的 key 列出名下全部机器，逐台把自动挂起设为关闭；幂等，已关闭的跳过，可安全重跑。
- **一次性**执行，不装服务、不留后台，跑一次就不用管了。
- 参数：`--key ibk_xxx` 命令行传 key；`--dry-run` 只预览会改哪些，不真改。
- key 只从环境变量 / `--key` / 本地 `.key` 读，`.key` 已在 `.gitignore`，仓库里不含任何凭证。

## 备用：keepalive.sh 续租保活

不想改机器设置，而是靠官方的 **activity lease** 定期续租，让它一直醒着；不需要在机器里装任何东西。通常首选上面那个一次性办法就够了，这条留作无法改设置时的备用方案。

> 为什么不在机器里面跑保活：机器一 suspend，里面的 cron/systemd 定时器全都冻住，谁也叫不醒自己。续租必须来自**外部**，靠那次请求真的出网。

```sh
# 保活名下全部机器（有几台保几台，机器名都不用填）
key=ibk_xxxxxx bash <(curl -Ls https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main/keepalive.sh)

# 只保活某一台： machine= 后面写你自己的机器名（下面「机器名从哪来」）
key=ibk_xxxxxx machine=qqq bash <(curl -Ls https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main/keepalive.sh)

# 非 root： curl -Ls <同一个地址> | sudo -E env key=ibk_xxxxxx machine=qqq sh
```

就一个文件 `keepalive.sh`：不带参数＝安装/更新，`uninstall`＝卸载，`--once` / `--watch` / `--status` / `--release`＝手动用。`sh keepalive.sh --help` 看全部参数。

装完会立刻做一次续租自检，失败就不装。服务形式按系统自动挑：**systemd → OpenRC → cron**。

## 机器名从哪来

`machine=qqq` 里的 `qqq` 只是示例，**换成你自己的机器名**。名字由你创建机器时指定（`instabox ls` 或网页面板都能看到），不用记也没关系：

- **不填 `machine`**（推荐）：脚本用你的 key 调 `GET /v1/machines` 自己列出名下所有机器，全部保活 —— 一个账号默认 5 台，5 台就续 5 个租约，新加机器下一轮自动跟上
- 填 `machine=名字`：只保这一台；也可以填机器 id（`m_...`）
- 填 `machine=all`：和不填一样

租约是**每台机器各一份**，名字相同也不会互相干扰。

## 变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `key` / `KEY` / `INSTABOX_API_KEY` | 无（必填） | `ibk_...`，至少要有 `machines:write` 权限 |
| `machine` / `INSTABOX_MACHINE` | 空＝全部 | 机器名 `qqq`、id `m_...`，或留空/`all` 表示保活名下每一台 |
| `INSTABOX_LEASE` | `keepalive` | 租约名，同名就是续同一个租约 |
| `INSTABOX_LEASE_TTL` | `300` | 秒，30–3600；留得越短越安全，但续租要跟得上 |
| `INSTABOX_RENEW_EVERY` | `0.6 × ttl` | 续租间隔 |
| `INSTABOX_AUTO_RESUME` | `1` | 续租碰到 `409 machine_not_running`（机器被挂起/停掉）就先 `resume`（`stopped` 用 `start` 兜底）等它 `running` 再续；设 `0` 只报错不唤醒 |
| `INSTABOX_WAKE_GAP` / `INSTABOX_WAKE_TRIES` | `5` / `3` | 唤醒后每次探测的间隔秒数 / 最多探测几次 |
| `INSTABOX_API_URL` | `https://api.instabox.sh` | 换私有网关时才用 |

安装参数（跟在不带参数的安装命令后面，或写成 `key=` 那种环境变量）：`--lease` `--ttl` `--dir`（默认 `/root/instabox-keepalive`）`--service`（默认 `instabox-keepalive`）`--raw`（自更新用的 raw 前缀）`--cron`（强制用 cron）`--no-start`。也接受 `install` 这个写法：`sh keepalive.sh install key=ibk_xxx`。

## 日常

```sh
sh /root/instabox-keepalive/keepalive.sh --status    # 机器状态 + 自动休眠设置（不填机器=全部）
sh /root/instabox-keepalive/keepalive.sh --once      # 手动续一次
sh /root/instabox-keepalive/keepalive.sh --release   # 放掉租约，恢复空闲休眠
sh /root/instabox-keepalive/keepalive.sh             # 想升级：直接再跑一次安装命令即可

# 彻底卸载（停服务、删 unit、清 cron 条目、放租约、删目录）
sh /root/instabox-keepalive/keepalive.sh uninstall

# 卸载可加： --keep-files 只停服务保留目录与 .env； --keep-lease 不动租约
```

一次 `--once` 的输出长这样（两台机器）：

```
2026-10-16 15:32:04 续租 ok qqq/keepalive 到期 2026-10-16T07:37:40.58732157Z
2026-10-16 15:32:04 续租 ok keepalive-multi-test/keepalive 到期 2026-10-16T07:37:40.677344789Z
```

## Cloudflare Worker 方案

不想为这件事常开一台机器，可以把续租放到 Worker 上（`worker/` 目录，cron 每 9 分钟跑一次，和你自己的机器无关）。

**网页面板部署（推荐，不用装 wrangler）**

1. Cloudflare 面板 → `Workers & Pages` → `Create` → `Worker` → 起个名字（例如 `instabox-keepalive`）→ `Deploy`
2. `Edit code`，把 `worker/worker.js` 的内容整段粘进去（覆盖默认代码）→ `Deploy`
3. `Settings` → `Variables and Secrets`，加这几条：

   | 变量 | 类型 | 值 |
   | --- | --- | --- |
   | `INSTABOX_API_KEY` | **Secret（加密）** | 你的 `ibk_...` |
   | `TOKEN` | Secret（自己起一串随机值） | 之后所有请求都要带 `?token=` |
   | `INSTABOX_MACHINE` | Text | 留空 = 保活全部机器；填 `qqq` 只保一台 |
   | `INSTABOX_LEASE_TTL` | Text | `900`（可选） |
   | `INSTABOX_LOG_MODE` | Text | `hourly`（默认）/ `every` / `off`，控制写 KV 的频次 |
   | `INSTABOX_AUTO_RESUME` | Text | `1`（默认）。机器被平台挂起/停掉时，先 `resume`（stopped 用 `start` 兜底）再续租；设 `0` 只报错不唤醒 |

   > `TOKEN` 强烈建议一定要设：不设的话，任何知道你 Worker 域名的人都能触发续租/释放。
   > `INSTABOX_LEASE_TTL` 要比 cron 间隔大：间隔 9 分钟就填 `900`，填 `300` 会在两次续租之间出现空窗。
4. `Settings` → `Triggers` → `Cron Triggers` → `Add Cron Trigger`，填 `*/9 * * * *`（每 9 分钟）→ 保存。这就是自动保活的开关
5. 想看 `/log`：`Storage & Databases` → `KV` → `Create namespace`，然后在 Worker 的 `Settings` → `Bindings` 里加一个 KV 绑定，**变量名填 `LOG`**、选刚建的空间。不绑也能用，只是 `/log` 是空的

**机器被挂起/停掉会怎样**

续租对 `suspended` / `stopped` 的机器一律回 `409 machine_not_running`——光续租是空转，机器不会自己醒。默认 `INSTABOX_AUTO_RESUME=1`：碰到这个错就先 `POST /resume`（`stopped` 的用 `/start` 兜底），等它变成 `running` 再立刻续租；日志里这条会带 `"resumed":true` 和 `"wake":["resume:202"]`。设成 `0` 就只报错、不唤醒。

**KV 额度够不够**

免费版 KV 每天 1000 次写、10 万次读。默认 `hourly` 模式下，同一小时的连续成功只写 1 条：每天约 24 次写（失败会立刻写，不受去重影响），占额度 2.4%，怎么跑都不会满。手动 `/?token=` 触发一定写日志，不参与去重。

| cron 间隔 | 次数/天 | `every` 模式写/天 | `hourly` 模式写/天 |
| --- | --- | --- | --- |
| `*/9` | 160 | 160 | ~24 |
| `*/4` | 360 | 360 | ~24 |
| `* * * * *` | 1440 | **1440（超了）** | ~24 |

也就是说：间隔 4 分钟以上用默认值随便跑；间隔 1 分钟的 `every` 会超额度，这时候要么留 `hourly`，要么把 `INSTABOX_LOG_MODE` 设成 `off` 完全不写。

**CLI 部署（可选）**

```sh
cd worker
npx wrangler secret put INSTABOX_API_KEY    # key 只进 secret，不写进 wrangler.toml
npx wrangler deploy
```

**域名 + token 手动触发**

```
https://<你的worker>.workers.dev/?token=xxx              续租一次，看结果
https://<你的worker>.workers.dev/status?token=xxx        机器状态
https://<你的worker>.workers.dev/log?token=xxx           最近 48 条保活日志
https://<你的worker>.workers.dev/log?token=xxx&format=text   纯文本，方便 grep
https://<你的worker>.workers.dev/release?token=xxx       放掉租约
```

`?token=` 就是上面那个 `TOKEN` 变量；设了就必须带，不带返回 `401 token 不对`。不带 `format=text` 时返回 JSON。cron 跑的结果和 `/` 一样，也写进 `/log`（绑了 KV 才有），每条记着时间、租约、几台、每台到期时间。

## 密钥安全

- 仓库里**没有也不该有**任何 key；`.env` 已被 `.gitignore`
- 装到目标机后 key 只存在 `<安装目录>/.env`，权限 `600`，通过 `EnvironmentFile`/`INSTABOX_ENV_FILE` 读取 —— 不落到进程列表里
- 安装时 key 会出现在你自己的命令行一次，装完记得 `history -c`；脚本输出里只会打码显示（`ibk_2ctf……urkq`）
- 建议给这把 key 只开 `machines:write`（+`machines:exec` 需要 exec 时），不要用账号的全权 key

## 已知事实（2026-10-16 实测）

- `PATCH /v1/machines/{id}` 传 `autoSuspendAfterSeconds: 0` **实测有效**（2026-10-18，5/5 台都改成功）；响应与后续 `GET` 回显为 `null`（=关）。早期版本判断“被静默忽略”是误报，可能当时机器的 `state` 不为运行或没带 `Idempotency-Key`
- 租约接口只认**机器 id**，传名字会 `404 machine not found`：脚本内部先用 `GET /v1/machines/{名字}` 换 id
- 租约 ttl 范围 30–3600 秒，单机最多 128 个；到期后才开始重新计空闲时间
- 机器 CPU 真忙、或终端有输入输出，本身不算空闲；但 `agent-browser` 模板没有 `activity` capability（`herdr` 有：带 agent 活动探针），跑静默任务才需要保活

## 免责声明

仅用于管理你自己账号下的 InstaBox 机器。请自行确认这把 key 的权限范围与所在机器的可信程度——保活进程能读取它，能读到这把 key 的人也能操作你的机器。使用本脚本产生的一切后果由使用者自行承担。

[MIT](LICENSE) © 2026 pingmike2
