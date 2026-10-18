#!/usr/bin/env bash
# instabox-disable-suspend — 一次性解除 instabox 云机的空闲自动挂起（休眠）机制。
#
# 原理：instabox 每台机器默认 30 分钟(1800s)空闲后自动 pause。
#       把 autoSuspendAfterSeconds 设为 0(=关) 即永不自动挂起。
#       幂等：已关闭的机器自动跳过，可安全重跑。
#
# 用法：
#   INSTABOX_API_KEY=<你的key> ./disable-sleep-mechanism.sh    # 单次执行
#   ./disable-sleep-mechanism.sh --key ibk_xxx                 # 或命令行传 key
#   ./disable-sleep-mechanism.sh --dry-run                     # 只列出会改哪些，不真改
#
# key 只从环境变量 / 命令行 / 本地 .key 文件读，永不打进仓库。
set -euo pipefail

API="https://api.instabox.sh"
DRY_RUN=0

# ---------- 参数 ----------
KEY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key) KEY="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$KEY" ]]; then KEY="${INSTABOX_API_KEY:-}"; fi
if [[ -z "$KEY" && -f "$(dirname "$0")/.key" ]]; then
  KEY="$(tr -d '[:space:]' < "$(dirname "$0")/.key")"
fi
if [[ -z "$KEY" ]]; then
  echo "错误：未提供 API key" >&2
  echo "  INSTABOX_API_KEY=*** $0  或  $0 --key ibk_xxx" >&2
  exit 1
fi

# ---------- 取机器列表（响应是 {machines:[...], nextCursor}）----------
list_machines() {
  curl -sf -H "X-API-Key: $KEY" "$API/v1/machines" \
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
  if curl -sf -X PATCH -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
       -H "Idempotency-Key: disable-suspend-$(date +%s)-$mid" \
       -d '{"autoSuspendAfterSeconds":0}' "$API/v1/machines/$mid" >/dev/null; then
    echo "  [OK]   $mid ($name)"
  else
    echo "  [失败] $mid ($name)" >&2
    return 1
  fi
}

echo "== $(date '+%F %T') 解除休眠机制 =="
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
