# InstaBox CLI 操作手册

管理 InstaBox 沙箱（机器）的命令行工具。安装、登录、建机、开机/关机、进去操作、快照、公开端口，全在这一条里。

---

## 一、安装与登录

### 1. 安装

```sh
curl -fsSL https://api.instabox.sh/install.sh | sh
```

装完跑起来之前，先让 CLI 认到服务器和账号凭证，二选一：

**方式 A —— 用 API key（推荐给脚本 / CI / 自动化）**

```sh
export INSTABOX_API_URL=https://api.instabox.sh
export INSTABOX_API_KEY=ibk_...
```

设了 `INSTABOX_API_KEY` 之后，所有命令都拿这把 key 当身份，不再需要登录态。

**方式 B —— 交互登录（用人，浏览器确认账号）**

```sh
instabox login
# 或指定提供商跳过账号确认：
instabox login --provider github    # google 同理
# 无浏览器环境用设备码：
instabox login --device
```

查看当前身份：`instabox whoami`；退出：`instabox logout`。

> 记住一条铁律：**key 只在创建时显示一次**。建完立刻存好，丢了只能到网页控制台（Profile → API keys）删掉重建。key 像密码，别进 Git。

---

## 二、API key 管理

```sh
instabox keys create --name mykey                       # 建，默认 scope
instabox keys create --name ci --scope machines:read machines:write   # 指定 scope
instabox keys ls                                        # 列出
instabox keys rm <key-id>                               # 吊销
```

常用 scope：
- `machines:read` —— 只读（list/get/operations/metrics）
- `machines:write` —— 增删改 + exec + SSH（**保活用这个就够**）
- `machines:delete` —— 删机器
- `images:read/write/delete` —— 快照

---

## 三、看配额与模板

```sh
instabox usage            # 你的沙箱/快照数量、配额、限制（json 加 --json）
instabox templates        # 能创建机器的模板列表
instabox whoami --json    # allowedSpecs = 你的账号能选哪些规格
```

马上要知道的几条现实约束：
- **免费计划只能从 `agent-browser` 模板建**（或你自己的快照），其余模板要被 403。
- 免费计划建机/启动限速：**3 台/分钟**，超了等一分钟再试。
- 免费计划单台最长运行 **480 分钟（8 小时）** 强制暂停。
- 默认每台 **4 vCPU / 8 GB**；Pro/Team 可加 `--vcpus 2 --mem-mib 4096` 等规格。
- 免费计划机器空闲默认 **30 分钟自动休眠**（要一直醒着，用下面的 `keepalive` 思路续 activity lease）。

---

## 四、创建机器

```sh
# 最简（免费计划默认 agent-browser 模板）
instabox create --name dev

# 指定模板 / 快照
instabox create --name dev --template agent-browser
instabox create --name dev --snapshot mysnapshot

# 指定规格 / 空闲策略 / 自定义元数据
instabox create --name build --vcpus 2 --mem-mib 4096
instabox create --name ci --auto-suspend 0          # 关闭空闲暂停（付费）
instabox create --name job --max-run-minutes 120     # 最多跑 120 分钟
instabox create --name box --meta task=review        # 打标签，便于 ls 过滤

# 不阻塞等建完（返回后异步创建）
instabox create --name dev --no-wait
```

- 机器名唯一；创建默认**开机**。
- `--auto-suspend 30m` 空闲 30 分钟自动暂停；`0` 关闭（付费）；默认 30 分钟。
- `--max-run-minutes` 与空闲限制**谁先到先触发**，暂停后两个计时器都重置。

---

## 五、机器生命周期

```sh
instabox ls                                          # 全部机器
instabox ls --meta task=review                       # 按元数据过滤
instabox get dev                                     # 单台详情

instabox start dev       # 开机（paused → 恢复进程；stopped → 冷启动）
instabox stop dev        # 关机（停掉）
instabox suspend dev     # 暂停（保留内存/进程，resume 接着跑）
instabox resume dev      # 恢复暂停的机器
instabox rm dev          # 删除

instabox rename dev dev2 # 改名（ID/端口/SSH 证书都不变）
instabox auto-suspend dev 30m     # 改空闲暂停时长，0=关
instabox max-run dev 180          # 改最长运行分钟，-1=不限(付费)，0=立即停
instabox wake dev        # 唤醒"自己暂停"的机器并等它跑到可用（最多 45s）
```

生命周期的区别记住：
- **suspend / pause** —— 保留内存和进程，`resume` 原地接着跑（快）。
- **stop** —— 彻底关机，`start` 冷启动（慢）。
- **rm** —— 删除，不可逆。**`rm` 前先确认**（`get dev` 看一眼）。
- `start|resume` 可加 `--no-vault` 关掉 vault 传递。

---

## 六、进机器干活

### 1. SSH（推荐）

```sh
instabox ssh dev                     # 交互登录
instabox ssh dev -- uname -a         # 带命令执行
instabox ssh-config dev              # 生成 ~/.ssh/config Host 块（其后可裸 ssh dev）
instabox ssh-cert dev                # 证书过期就刷新
```

### 2. exec（不需要 SSH 客户端，跑单条命令）

```sh
instabox exec dev -- node -v
instabox exec dev --cwd /data/home --env FOO=bar --timeout 120 -- ./build.sh
instabox exec dev --stdin -- cat > /data/home/notes.txt
```

`exec` 用 `bash -lc` 以机器登录用户跑，返回 stdout/stderr 和退出码，最长 10 分钟。

### 3. mosh / 局域网

```sh
instabox mosh dev       # 断线/换网不掉会话（需本机装 mosh）
```

### 4. 发一次性访问令牌（任何终端都能连）

```sh
instabox ssh-token dev                    # 打出一条裸 ssh 命令，7 天有效
instabox ssh-token dev --ttl 1h           # 有效期 1 小时~30 天
instabox ssh-token dev --mosh             # 换成 mosh 命令
instabox ssh-token --revoke dev           # 吊销这个沙箱的令牌版登录
```

### 5. 看/改机器里的文件（不装 SSH 也能看）

```sh
instabox files dev                       # 列工作目录
instabox files dev /etc/hosts            # 打印文本文件（root 身份、实时）
```

---

## 七、快照（保存机器状态，可再建）

```sh
instabox snapshot save dev --name mybase                 # 保存整机
instabox snapshot save dev --name sys --root-only        # 只存系统盘(不含 /data)
instabox snapshot ls                                     # 列快照
instabox snapshot files mybase /data/notes.txt           # 看快照里的文件
instabox snapshot rm mybase                              # 删快照
```

用快照再建新机器：`instabox create --name vm2 --snapshot mybase`。

---

## 八、公开端口（把沙箱里的 HTTP 服务映射成公网 URL）

```sh
instabox port publish dev 3000                  # 发布端口，得到一条公网 HTTPS URL
instabox port ls [dev]                          # 列出公开端口
instabox port unpublish dev 3000                # 撤下并断开连接
instabox port setup dev                         # 安装沙箱内的 instabox-port 命令
```

- 一个端口反复 publish 保持同一个 URL。
- URL **只在机器运行时响应**；暂停/停止返回 503。

---

## 九、工作区 / 多人协作（workspace，alias: org）

```sh
instabox workspace ls                          # 我的所有工作区
instabox workspace get myws                    # 某工作区的计划与用量
instabox workspace create myws --plan pro      # 建工作区（需 checkout）
instabox workspace invite myws                 # 生成一次性邀请码
instabox workspace join CODE                   # 加入
instabox workspace members myws                # 成员
# rename | role | rm-member | leave | invites | revoke-invite
```

> 快速上手：`instabox workspace help`、`instabox secrets help` 有完整子命令。

---

## 十、Secrets（组织级密钥，按目标主机定向下发）

```sh
# 从 stdin / 交互输入，仅发给指定 host
instabox secrets set DB_PASS --host api.example.com
instabox secrets import .env --host api.example.com --host cdn.example.com
instabox secrets ls [--org O] [--json]         # 只看元数据，永不出值
instabox secrets rm DB_PASS [--org O]
instabox secrets select dev --secrets all      # 选定沙箱要哪些 secret
instabox secrets push dev [--json]             # 立即刷新下发
instabox secrets show dev                      # 沙箱当前选择与代理状态
```

机制：沙箱里放**占位符**，出网代理在访问该 Secret 的 host 时把真实值填进 HTTPS 请求头。没搭配 `--host`，值不会乱发。

---

## 十一、全局选项与环境变量

```sh
# 全局 flag（命令前或后都行）
--server URL             # API 服务器（env: INSTABOX_SERVER / INSTABOX_API_URL）
--ca-cert FILE           # 额外的 CA 证书（env: INSTABOX_CA_CERT）
--insecure-skip-verify   # 跳过证书校验（仅开发）
--version                # 版本号

# 环境变量
export INSTABOX_API_KEY=ibk_...      # 用 key 当身份
export INSTABOX_NO_TELEMETRY=1       # 关闭遥测（或 DO_NOT_TRACK=1）
```

---

## 十二、把它接上保活（instabox-keepalive）

CLI 用来**建和管理**机器；要机器**一直醒着**不被空闲挂起，用本仓库的方案：

- **Keepalive 脚本**：`keepalive.sh` 装在任何常开机器/容器里，定期调用官方 **activity lease** 续租，配 `key=ibk_aaa,ibk_bbb` 可同时护多账号。
- **Cloudflare Worker**：不想自己找常开机器时，把机器 key 作为 secret 存进 worker，cron 每 9 分钟自动续租。
- 保活只负责**续租**，不负责建机 —— 先用上面第 4 节把机器建出来，保活才能捧着。

---

## 常见坑速查

| 现象 | 原因 / 处置 |
|---|---|
| `template universal` 建机 403 | 免费计划只能 `agent-browser`（或快照）。换模板或升 pro |
| 建机 429 限速 | 免费 3 台/分钟，等 60s 再试 |
| 免费机器 480 分钟后停了 | 免费计划单台最长 480 分钟，属强制行为 |
| 机器空闲自动休眠 | 默认 30 分钟；用保活 lease 或 `--auto-suspend 0`（付费） |
| `ssh` 连不上/证书报错 | 先 `instabox ssh-cert dev` 刷新证书 |
| key 看不到了 | 只在创建时显示一次；删了重建一根 |
| `instabox rm` 手滑 | 不可逆，`rm` 前 `get dev` 确认（无回收站） |
