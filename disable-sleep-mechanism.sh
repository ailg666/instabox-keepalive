#!/usr/bin/env bash
# instabox-disable-suspend — 一次性解除 instabox 云机的空闲自动挂起（休眠）机制。
#
# 原理：instabox 每台机器默认 30 分钟(1800s)空闲后自动 pause。
#       把 autoSuspendAfterSeconds 设为 0(=关) 即永不自动挂起。
#       幂等：已关闭的机器自动跳过，可安全重跑。
#
# 用法：
#   APIKEY=*** bash <(curl -Ls https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main/disable-sleep-mechanism.sh)
#   INSTABOX_API_KEY=<你的key> ./disable-sleep-mechanism.sh    # 或本地跑
#   ./disable-sleep-mechanism.sh --dry-run                     # 只列出会改哪些，不真改
#
# key 只从环境变量 / 命令行 / 本地 .key 文件读，永不打进仓库。
set -euo pipefail

API="https://api.instabox.sh"
DRY_RUN=0

# ---------- 参数 ----------
# 兼容 key / KEY / APIKEY / INSTABOX_API_KEY 四种环境变量写法（低优先级的先读）
AK=""
if [[ -z "$AK" ]]; then AK="${APIKEY:-}"; fi
if [[ -z "$AK" ]]; then AK="${key:-}"; fi
if [[ -z "$AK" ]]; then AK="${KEY:-}"; fi
if [[ -z "$AK" ]]; then AK="${INSTABOX_API_KEY:-}"; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key) AK="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$AK" && -f "$(dirname "$0")/.key" ]]; then
  AK="$(tr -d '[:space:]' < "$(dirname "$0")/.key")"
fi
if [[ -z "$AK" ]]; then
  echo "错误：未提供 API key" >&2
  echo "  APIKEY=*** bash <(curl -Ls <raw 地址>/disable-sleep-mechanism.sh)  或  ./disable-sleep-mechanism.sh --key ibk_xxx" >&2
  exit 1
fi
# 之后所有请求都带 AK

# ---------- 取机器列表（响应是 {machines:[...], nextCursor}）----------
list_machines() {
  curl -sf -H "X-API-Key: $AK" "$API/v1/machines" \
    | python3 -c 'import sys,json
d=json.load(sys.stdin)
for m in d.get("machines",[]):
    print(m["id"]+"\t"+str(m.get("name",""))+"\t"+str(m.get("autoSuspendAfterSeconds")))'
}

disable_one() {
  local mid="$1" name="$2" cur="$3"
  if [[ "$cur" == "null" || "$cur" == "0" || "$cur" == "None" ]]; then
    echo "  [跳过] $mid ($name) 已关闭 (autoSuspend=$cur)"
    return 0
  fi
  echo "  [改]   $mid ($name) autoSuspend $cur -> 0"
  if [[ $DRY_RUN -eq 1 ]]; then return 0; fi
  curl -sf -X PATCH -H "X-API-Key: $AK" -H "Content-Type: application/json" \
       -H "Idempotency-Key: disable-suspend-$(date +%s)-$mid" \
       -d '{"autoSuspendAfterSeconds":0}' "$API/v1/machines/$mid" >/dev/null || true
  # 不信回包，回查真实值：服务端可能静默忽略
  local after
  after="$(curl -sf -H "X-API-Key: $AK" "$API/v1/machines/$mid" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("autoSuspendAfterSeconds"))' 2>/dev/null || echo unknown)"
  if [[ "$after" == "null" || "$after" == "0" || "$after" == "None" ]]; then
    echo "  [OK]   $mid ($name) 已关闭"
  else
    echo "  [无效] $mid ($name) 服务端未接受，仍为 $after"
    return 1
  fi
}

# 账号级预检：fixedAutoSuspendSeconds 非 0 时，改机器字段一定无效
account_note() {
  local fixed
  fixed="$(curl -sf -H "X-API-Key: $AK" "$API/v1/me" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("fixedAutoSuspendSeconds"))' 2>/dev/null || echo unknown)"
  if [[ "$fixed" == "0" || "$fixed" == "None" || "$fixed" == "null" ]]; then
    echo "  账号空闲阈值: 未锁定（fixedAutoSuspendSeconds=$fixed），可以尝试关闭"
  else
    echo "  ！账号空闲阈值被服务端锁死: fixedAutoSuspendSeconds=$fixed（/v1/me，只读）"
    echo "    这会让本脚本对每台机器的修改全部被静默忽略 —— 请改用 keepalive.sh 续租保活。"
  fi
}

echo "== $(date '+%F %T') 解除休眠机制 =="
account_note
machines="$(list_machines)" || { echo "  (机器列表读取失败)" >&2; exit 1; }
if [[ -z "$machines" ]]; then
  echo "  (该 key 下没有机器)"
  exit 0
fi
failed=0
while IFS=$'\t' read -r mid name cur; do
  [[ -z "$mid" ]] && continue
  disable_one "$mid" "$name" "$cur" || failed=1
done <<< "$machines"
echo "-- 结束 $(date '+%F %T') --"
exit $failed
