# instabox-keepalive

[InstaBox](https://instabox.sh) 的机器空闲 30 分钟就会自动休眠（`auto-suspend`）。本仓库用官方的 **activity lease** 定期续租，让它一直醒着，两种跑法都在这个仓库：

- **Cloudflare Worker**（推荐）：cron 每 9 分钟续一次租，不需要你自己的机器常开，一个 Worker 能同时带多个账号（多把 key 无限叠加）
- **VPS shell 脚本**（`keepalive.sh`）：装在你自己的机器/NAS 上定时续租，同样支持 409 自愈（挂起自动唤醒）

> **为什么不能直接把休眠关掉**（`autoSuspendAfterSeconds=0`）？2026-10-18 实测：普通/邀请制账号的 `/v1/me` 里有 `"fixedAutoSuspendSeconds": 1800`、`"manualLifecycle": false`，服务端把空闲挂起阈值**锁死在账号级**，因此对 `PATCH /v1/machines/{id}` 传 `autoSuspendAfterSeconds: 0`（或任何值，含官方 `instabox auto-suspend <box> 0` 与 SDK `setAutoSuspend`）**一律被静默忽略**：返回 200，值仍是 1800。详见文末《为什么关不掉休眠》。所以只能用租约这条官方口子。

> 为什么不在机器里面跑保活：机器一 suspend，里面的 cron/systemd 定时器全都冻住，谁也叫不醒自己。续租必须来自**外部**，靠那次请求真的出网 —— 这也是把续租放到 Cloudflare Worker 上的原因。

## cloudflare的worker部署（网页面板，推荐，不用装 wrangler）

1. Cloudflare 面板 → `Workers & Pages` → `Create` → `Worker` → 起个名字（例如 `instabox-keepalive`）→ `Deploy`
2. `Edit code`，把 `worker/worker.js` 的内容整段粘进去（覆盖默认代码）→ `Deploy`
3. `Settings` → `Variables and Secrets`，加这几条：

   | 变量 | 类型 | 值 |
   | --- | --- | --- |
   | `INSTABOX_API_KEY` | **Secret（加密）** | 你的 `ibk_...`（多账号见下面《多个账号》） |
   | `TOKEN` | Secret（自己起一串随机值） | 之后所有请求都要带 `?token=` |
   | `INSTABOX_MACHINE` | Text | 留空 = 保活该 key 名下全部机器；填 `qqq` 只保一台（多台用逗号分隔） |
   | `INSTABOX_LEASE` | Text | `keepalive`（可选） |
   | `INSTABOX_LEASE_TTL` | Text | `900`（建议；不填默认 300，会比 cron 间隔小） |
   | `INSTABOX_LOG_MODE` | Text | `hourly`（默认）/ `every` / `off`，控制写 KV 的频次 |
   | `INSTABOX_AUTO_RESUME` | Text | `1`（默认）。机器被平台挂起/停掉时，先 `resume`（stopped 用 `start` 兜底）再续租；设 `0` 只报错不唤醒 |
   | `INSTABOX_API_URL` | Text | `https://api.instabox.sh`（换私有网关时才用加这个变量） |

   > `TOKEN` 强烈建议一定要设：不设的话，任何知道你 Worker 域名的人都能触发续租/释放。
   > `INSTABOX_LEASE_TTL` 要比 cron 间隔大：间隔 9 分钟就填 `900`，填 `300` 会在两次续租之间出现空窗。
4. `Settings` → `Triggers` → `Cron Triggers` → `Add Cron Trigger`，填 `*/9 * * * *`（每 9 分钟）→ 保存。这就是自动保活的开关
5. 想看 `/log`：`Storage & Databases` → `KV` → `Create namespace`，然后在 Worker 的 `Settings` → `Bindings` 里加一个 KV 绑定，**变量名填 `LOG`**、选刚建的空间。不绑也能用，只是 `/log` 是空的

**机器筛选**

- 不填 `INSTABOX_MACHINE`（推荐）：Worker 用你的 key 调 `GET /v1/machines` 自己列出名下所有机器，全部保活 —— 一个账号默认 支持多台，新加机器下一轮自动跟上
- 填 `qqq` 只保这一台；也可以填机器 id（`m_...`）；多台用逗号分隔，例如 `qqq,box2`
- 机器名由你创建机器时指定（`instabox ls` 或网页面板都能看到）
- 租约是**每台机器各一份**，名字相同也不会互相干扰

## 多个账号

**一个账号就是一套单账号变量，第 N 个账号的变量名加 `_N` 后缀**。

| 1 号账号（和单账号完全一样） | 2 号账号 | 说明 |
| --- | --- | --- |
| `INSTABOX_API_KEY` | `INSTABOX_API_KEY_2` | **Secret**，必填 |
| `INSTABOX_MACHINE` | `INSTABOX_MACHINE_2` | 可选，留空 = 该账号全部机器 |
| `INSTABOX_LEASE` | `INSTABOX_LEASE_2` | 可选，默认 `keepalive` |
| `INSTABOX_LEASE_TTL` | `INSTABOX_LEASE_TTL_2` | 可选，默认 `900` |
| `INSTABOX_AUTO_RESUME` | `INSTABOX_AUTO_RESUME_2` | 可选，默认 `1` |

- 加一个账号 = 在面板上再加一个 `INSTABOX_API_KEY_2` Secret，就这一步
- 带后缀的优先，没写的自动继承不带后缀的全局值；`INSTABOX_MACHINE` 也会继承，所以两个账号机器名不一样时记得写 `INSTABOX_MACHINE_2`
- 编号可以不连续（只配 `_2` 也能跑）；`INSTABOX_API_KEY_1` 等同于 `INSTABOX_API_KEY`
- 同一把 key 配了两次只续一次
- **一个变量塞多把也行（推荐，无限叠加）**：`INSTABOX_API_KEY = "ibk_aaa,ibk_bbb,ibk_ccc"`（逗号分隔）→ 自动按顺序当 1、2、3 号账号，加账号就是往里续一段 `,ibk_xxx`。两种写法混着用也行：显式 `_N` 变量永远占自己的编号，多出来的往外推空位（比如 `INSTABOX_API_KEY="kA,kB"` 且 `_2=kX` → 1=kA、2=kX、3=kB）。单把 key 的老用法不变
- 每个账号的机器列表分开缓存、分开续租：某个账号 key 失效或机器被挂起，不影响其它账号
- `/accounts` 看现在认到了几个账号（key 打码）；`?account=2` 只操作 2 号（`/`、`/status`、`/release` 都支持）
- KV 绑定不用动：还是 `LOG`、还是每小时最多 1 条，多账号只是让每条日志里多几个 `account` 编号
- 免费版 Worker 每次调用最多 50 个子请求：一个账号大约「1 次列机器 + 每台 1 次续租」，账号/机器多的时候别超（付费版 1000 次）

**配置示例：三把 key，其它全用全局值**

面板 `Variables and Secrets` 里最终就这几条（key 和 token 都是 Secret）：

| 变量 | 类型 | 值 |
| --- | --- | --- |
| `INSTABOX_API_KEY` | Secret | `ibk_aaa…`（1 号账号） |
| `INSTABOX_API_KEY_2` | Secret | `ibk_bbb…`（2 号账号） |
| `INSTABOX_API_KEY_3` | Secret | `ibk_ccc…`（3 号账号） |
| `TOKEN` | Secret | 自己起一串随机值，例如 `openssl rand -hex 16` 的输出 |
| `INSTABOX_LEASE_TTL` | Text | `900` |
| `INSTABOX_LOG_MODE` | Text | `hourly` |

`INSTABOX_MACHINE` / `INSTABOX_LEASE` / `INSTABOX_AUTO_RESUME` 都不写，效果就是：每个账号保活自己名下**全部机器**、租约名 `keepalive`、碰到挂起/停掉自动唤醒。cron 填 `*/9 * * * *`。

**懒人写法（推荐）**：三种等价 —— 要几个加几个。

```sh
# 单变量塞多把（推荐）：加账号就是往里续 ",ibk_xxx"
INSTABOX_API_KEY = ibk_aaa,ibk_bbb,ibk_ccc
# 或每把一个 secret（老写法，效果一样）
INSTABOX_API_KEY   = ibk_aaa
INSTABOX_API_KEY_2 = ibk_bbb
INSTABOX_API_KEY_3 = ibk_ccc
# 或混着用（显式 _N 的编号优先，多出来的往外推空位）
INSTABOX_API_KEY   = ibk_aaa,ibk_bbb
INSTABOX_API_KEY_2 = ibk_xxx      # 占死 2 号位；任务变成 1=aaa 2=xxx 3=bbb
```

反过来，如果几个账号都只想保活同名的那台机器（比如都叫 `qqq`），只写一个 `INSTABOX_MACHINE=qqq` 就行，所有账号都会继承这个筛选。

CLI 部署等价操作（`worker/wrangler.toml` 里已经带了 cron 和 `INSTABOX_LEASE_TTL=900`）：

```sh
cd worker
npx wrangler secret put INSTABOX_API_KEY
npx wrangler secret put INSTABOX_API_KEY_2
npx wrangler secret put INSTABOX_API_KEY_3
npx wrangler secret put TOKEN
npx wrangler deploy
```

部署完打开 `/accounts?token=...`，看到 `#1`、`#2`、`#3` 三行（key 打码）就说明三把 key 都认到了；再打开 `/status?token=...` 看每个账号下的机器。

## VPS 版 keepalive.sh（自己的机器/NAS 上跑）

不想用 Cloudflare 就把脚本装到任何一台常开的机器（VPS/NAS/路由器），cron/systemd 定时续租：

```sh
# 一行装好（key 只落本机 0600 的 .env）；机器名留空 = 保全部
key=ibk_xxx bash <(curl -Ls https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main/keepalive.sh)
# 也支持机器内逗号分隔多把 key（每把 key 各保各的），无限叠加、单个也能跑：
key=ibk_aaa,ibk_bbb,ibk_ccc machine=qqq,box2 bash <(curl -Ls https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main/keepalive.sh)
```

- 装完自动 systemd/OpenRC/cron 三选一，看 `sh keepalive.sh --status`；卸载 `sh keepalive.sh uninstall`
- `INSTABOX_AUTO_RESUME` 默认开：续租遇 409 先 resume（stopped 用 start 兜底）再续；`INSTABOX_WAKE_GAP`/`INSTABOX_WAKE_TRIES` 控制唤醒轮询（5s × 3 次）
- 多把 key：`.env` 里 `INSTABOX_API_KEY=ibk_aaa,ibk_bbb`，脚本逐把续租；以后加 key 直接往变量后面续逗号
- 重跑安装命令 = 按现有 `.env` 升级，key 不会丢

## 机器被挂起/停掉会怎样

续租对 `suspended` / `stopped` 的机器一律回 `409 machine_not_running`——光续租是空转，机器不会自己醒。默认 `INSTABOX_AUTO_RESUME=1`：碰到这个错就先 `POST /resume`（`stopped` 的用 `/start` 兜底），等它变成 `running` 再立刻续租；日志里这条会带 `"resumed":true` 和 `"wake":["resume:202"]`。设成 `0` 就只报错、不唤醒。

## 接口

```
https://<你的worker>.workers.dev/?token=xxx                   所有账号各续租一次
https://<你的worker>.workers.dev/status?token=xxx             所有账号的机器状态
https://<你的worker>.workers.dev/accounts?token=xxx           配了哪些账号（key 打码）
https://<你的worker>.workers.dev/log?token=xxx                最近 48 条保活日志
https://<你的worker>.workers.dev/log?token=xxx&format=text    纯文本，方便 grep
https://<你的worker>.workers.dev/release?token=xxx            放掉租约
https://<你的worker>.workers.dev/status?token=xxx&account=2   只看 2 号账号（/、/release 同样支持）
```

`?token=` 就是上面那个 `TOKEN` 变量；设了就必须带，不带返回 `401 token 不对`。不带 `format=text` 时返回 JSON，任何路由都能加 `&format=text` 看纯文本。cron 跑的结果和 `/` 一样，也写进 `/log`（绑了 KV 才有），每条记着时间、租约、几台、每台到期时间；多账号时每台机器还带 `account` 编号（`1`、`2`…）。

## KV 额度够不够

免费版 KV 每天 1000 次写、10 万次读。默认 `hourly` 模式下，同一小时的连续成功只写 1 条：每天约 24 次写（失败会立刻写，不受去重影响），占额度 2.4%，怎么跑都不会满。手动 `/?token=` 触发一定写日志，不参与去重。

多账号不会增加写次数：一条日志装的是所有账号的汇总，`hourly` 模式下仍然每小时最多 1 条，额度算法和单账号完全一样。KV 绑定名、namespace、`log` 这个 key 也都不用改。

| cron 间隔 | 次数/天 | `every` 模式写/天 | `hourly` 模式写/天 |
| --- | --- | --- | --- |
| `*/9` | 160 | 160 | ~24 |
| `*/4` | 360 | 360 | ~24 |
| `* * * * *` | 1440 | **1440（超了）** | ~24 |

也就是说：间隔 4 分钟以上用默认值随便跑；间隔 1 分钟的 `every` 会超额度，这时候要么留 `hourly`，要么把 `INSTABOX_LOG_MODE` 设成 `off` 完全不写。

## CLI 部署（可选）

```sh
cd worker
npx wrangler secret put INSTABOX_API_KEY       # 1 号账号（key 只进 secret，不写进 wrangler.toml）
npx wrangler secret put INSTABOX_API_KEY_2     # 2 号账号，要几个加几个
npx wrangler deploy
```

`worker/wrangler.toml` 里已经设好 `crons = ["*/9 * * * *"]` 和 `INSTABOX_LEASE_TTL = "900"`，按需改就行。


## 免责声明

仅用于管理你自己账号下的 InstaBox 机器。请自行确认每把 key 的权限范围与所在机器的可信程度 —— Worker 能读到这些 key，能读到它们的人也能操作你的机器。使用本项目产生的一切后果由使用者自行承担。

[MIT](LICENSE) © 2026
