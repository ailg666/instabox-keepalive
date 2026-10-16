#!/bin/sh
# InstaBox keepalive — renew an activity lease so a box never idle-suspends.
#
# Pure POSIX sh (Alpine/BusyBox, Debian, Ubuntu, OpenWrt…), needs only curl.
# Nothing runs inside the box: a suspended machine freezes its own timers, so
# the renewal must come from outside over the network.
#
#   ./keepalive.sh              loop forever, renewing before the lease expires
#   ./keepalive.sh --once       renew once, exit 0/1 (use from cron)
#   ./keepalive.sh --status     print machine state + auto-suspend settings
#   ./keepalive.sh --release    drop the lease, restoring normal idle suspend
#
# A `.env` sitting next to this file is sourced first, so a service can keep the
# key out of the process list. The environment always wins over `.env`.
#
#   INSTABOX_API_KEY      required   ibk_...      (aliases: key, KEY, IBK)
#   INSTABOX_MACHINE      required   qqq  or  m_...  (alias: machine)
#   INSTABOX_LEASE        keepalive  lease name — renewing a name extends it
#   INSTABOX_LEASE_TTL    300        30-3600 seconds
#   INSTABOX_RENEW_EVERY  0.6 x ttl  seconds between renewals
#   INSTABOX_API_URL      https://api.instabox.sh
set -u

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE=${INSTABOX_ENV_FILE:-$SELF_DIR/.env}
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

API=${INSTABOX_API_URL:-${api:-https://api.instabox.sh}}
KEY=${INSTABOX_API_KEY:-${key:-${KEY:-${IBK:-}}}}
MACHINE=${INSTABOX_MACHINE:-${machine:-}}
LEASE=${INSTABOX_LEASE:-keepalive}
TTL=${INSTABOX_LEASE_TTL:-300}
RENEW=${INSTABOX_RENEW_EVERY:-$((TTL * 3 / 5))}
MID=
LABEL=

HTTP_BODY=
HTTP_CODE=

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "错误: $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "缺 curl（Alpine: apk add curl / Debian: apt-get install -y curl）"

jget() { # jget <json> <key> -> leftmost value of "key":…, unquoted
	printf '%s' "$1" | awk -v k="$2" '
		match($0, "\"" k "\":[^,}]*") {
			v = substr($0, RSTART + length(k) + 3, RLENGTH - length(k) - 3)
			gsub(/^"|"$/, "", v)
			print v
			exit
		}'
}

# http <METHOD> <PATH> [JSON_BODY] -> HTTP_CODE + HTTP_BODY
http() {
	local method=$1 path=$2 data=${3:-} resp
	if [ -n "$data" ]; then
		resp=$(curl -sS -m 30 -X "$method" "$API$path" \
			-H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
			-d "$data" -w '\n%{http_code}' 2>&1) || { HTTP_CODE=0; HTTP_BODY=$resp; return 1; }
	else
		resp=$(curl -sS -m 30 -X "$method" "$API$path" \
			-H "X-API-Key: $KEY" -w '\n%{http_code}' 2>&1) || { HTTP_CODE=0; HTTP_BODY=$resp; return 1; }
	fi
	HTTP_CODE=$(printf '%s' "$resp" | tail -n 1)
	HTTP_BODY=$(printf '%s' "$resp" | sed '$d')
	[ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ]
}

# The lease routes take a machine id only; names work on GET /v1/machines/{id},
# so a name is turned into its id once at startup.
resolve() {
	case "$MACHINE" in
		m_*) MID=$MACHINE; return 0 ;;
	esac
	http GET "/v1/machines/$MACHINE" || { log "找不到机器 $MACHINE（HTTP $HTTP_CODE）: $HTTP_BODY"; return 1; }
	MID=$(jget "$HTTP_BODY" id)
	[ -n "$MID" ] || { log "没解析出机器 id: $HTTP_BODY"; return 1; }
	return 0
}

preflight() {
	[ -n "$KEY" ] || die "未设置 INSTABOX_API_KEY（或 key=…）"
	[ -n "$MACHINE" ] || die "未设置 INSTABOX_MACHINE（或 machine=…）"
	case "$TTL" in ''|*[!0-9]*) die "TTL 必须是数字: $TTL" ;; esac
	if [ "$TTL" -lt 30 ] || [ "$TTL" -gt 3600 ]; then
		die "TTL 必须在 30-3600 秒之间（当前 $TTL）"
	fi
	[ -n "$MID" ] || resolve || exit 1
	LABEL=$MACHINE
	[ "$MID" = "$MACHINE" ] || LABEL="$MACHINE（$MID）"
}

renew() {
	preflight
	if ! http PUT "/v1/machines/$MID/activity-leases/$LEASE" "{\"ttlSeconds\":$TTL}"; then
		log "续租失败 $LABEL/$LEASE HTTP $HTTP_CODE: $HTTP_BODY"
		return 1
	fi
	log "续租 ok $LABEL/$LEASE 到期 $(jget "$HTTP_BODY" expiresAt)"
	return 0
}

release() {
	preflight
	if http DELETE "/v1/machines/$MID/activity-leases/$LEASE"; then
		log "已释放租约 $LABEL/$LEASE"
		return 0
	fi
	if [ "$HTTP_CODE" = "404" ]; then
		log "租约本来就不存在 $LABEL/$LEASE"
		return 0
	fi
	log "释放失败 HTTP $HTTP_CODE: $HTTP_BODY"
	return 1
}

status() {
	preflight
	if ! http GET "/v1/machines/$MID"; then
		log "读机器失败 HTTP $HTTP_CODE: $HTTP_BODY"
		return 1
	fi
	log "$LABEL state=$(jget "$HTTP_BODY" state) \
autoSuspendAfterSeconds=$(jget "$HTTP_BODY" autoSuspendAfterSeconds) \
autoSuspendedAt=$(jget "$HTTP_BODY" autoSuspendedAt)"
	return 0
}

CMD=${1:-}
[ -n "$CMD" ] || CMD=--watch
case "$CMD" in
	--once)    renew ;;
	--release) release ;;
	--status)  status ;;
	--watch|-w)
		preflight
		log "watch: 每 ${RENEW}s 续租 $LABEL/$LEASE（ttl ${TTL}s），API $API"
		while :; do
			renew || log "这一轮失败，下一轮再试"
			sleep "$RENEW"
		done
		;;
	-h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//' ;;
	*)         echo "用法: $0 [--watch|--once|--status|--release|--help]" >&2; exit 2 ;;
esac
