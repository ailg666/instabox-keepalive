# instabox-keepalive

[InstaBox](https://instabox.sh) 的机器空闲 30 分钟就会自动休眠（`auto-suspend`）。这个脚本用官方的 **activity lease** 定期续租，让它一直醒着；不需要在机器里装任何东西。

> 为什么不在机器里面跑保活：机器一 suspend，里面的 cron/systemd 定时器全都冻住，谁也叫不醒自己。续租必须来自**外部**，靠那次请求真的出网。

```sh
# 一条命令装好（Debian/Ubuntu/Alpine 都行，需要 root）
key=ibk_xxxxxx machine=qqq bash <(curl -Ls https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main/install.sh)

# 非 root 时
curl -Ls https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main/install.sh | sudo -E env key=ibk_xxxxxx machine=qqq sh
```

装完会立刻做一次续租自检，失败就不装。服务形式按系统自动挑：**systemd → OpenRC → cron**。

## 变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `key` / `KEY` / `INSTABOX_API_KEY` | 无（必填） | `ibk_...`，至少要有 `machines:write` 权限 |
| `machine` / `INSTABOX_MACHINE` | 无（必填） | 机器名 `qqq` 或 id `m_...` |
| `INSTABOX_LEASE` | `keepalive` | 租约名，同名就是续同一个租约 |
| `INSTABOX_LEASE_TTL` | `300` | 秒，30–3600；留得越短越安全，但续租要跟得上 |
| `INSTABOX_RENEW_EVERY` | `0.6 × ttl` | 续租间隔 |
| `INSTABOX_API_URL` | `https://api.instabox.sh` | 换私有网关时才用 |

安装参数：`--lease` `--ttl` `--dir`（默认 `/root/instabox-keepalive`）`--service`（默认 `instabox-keepalive`）`--cron`（强制用 cron）`--no-start` `--uninstall`。

## 日常

```sh
sh /root/instabox-keepalive/keepalive.sh --status    # 机器状态 + 自动休眠设置
sh /root/instabox-keepalive/keepalive.sh --once      # 手动续一次
sh /root/instabox-keepalive/keepalive.sh --release   # 放掉租约，恢复空闲休眠
sh /root/instabox-keepalive/uninstall.sh             # 彻底卸载（停服务、删 unit、放租约、删目录）
```

## Cloudflare Worker 方案

不想为这件事常开一台机器，可以把续租放到 Worker 上（`worker/` 目录，cron 每 4 分钟跑一次，和你自己的机器无关）：

```sh
cd worker
npx wrangler secret put INSTABOX_API_KEY    # key 只进 secret，不写进 wrangler.toml
npx wrangler deploy
```

手动触发：`GET /` 续租、`GET /status` 看状态、`GET /release` 放租约；把 `TOKEN` 变量设上就要求 `?token=...`。

## 密钥安全

- 仓库里**没有也不该有**任何 key；`.env` 已被 `.gitignore`
- 装到目标机后 key 只存在 `<安装目录>/.env`，权限 `600`，通过 `EnvironmentFile`/`INSTABOX_ENV_FILE` 读取 —— 不落到进程列表里
- 安装时 key 会出现在你自己的命令行一次，装完记得 `history -c`；脚本输出里只会打码显示
- 建议给这把 key 只开 `machines:write`（+`machines:exec` 需要 exec 时），不要用账号的全权 key

## 已知事实（2026-10-16 实测）

- `PATCH /v1/machines/{id}` 传 `autoSuspendAfterSeconds: 0` **被服务端静默忽略**（非 0 值也一样），`instabox auto-suspend <box> 0` 走同一字段，同样无效 —— 所以只能用租约这条官方口子
- 租约 ttl 范围 30–3600 秒，单机最多 128 个；到期后才开始重新计空闲时间
- 机器 CPU 真忙、或终端有输入输出，本身不算空闲；但 `agent-browser` 模板没有 `activity` capability（`herdr` 有：带 agent 活动探针），跑静默任务才需要保活

## 免责声明

仅用于管理你自己账号下的 InstaBox 机器。请自行确认这把 key 的权限范围与所在机器的可信程度——保活进程能读取它，能读到这把 key 的人也能操作你的机器。使用本脚本产生的一切后果由使用者自行承担。

[MIT](LICENSE) © 2026 pingmike2
