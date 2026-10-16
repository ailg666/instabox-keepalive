#!/bin/sh
# InstaBox keepalive — renew activity leases so a box never idle-suspends.
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
#   INSTABOX_MACHINE      optional   qqq | m_...  (alias: machine)
#                                    empty / all / * = every machine the key sees
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
ALL=0
case "$MACHINE" in ""|all|ALL|All|'*') ALL=1 ;; esac

HTTP_BODY=
HTTP_CODE=

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "错误: $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "缺 curl（Alpine: apk add curl / Debian: apt-get install -y curl）"

# jget <json> <key> -> leftmost value of "key":…, unquoted
jget() {
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
# so a name is turned into its id once, and `all` lists everything the key sees.
# jq and python3 are used when present; the awk fallback walks brace depth so it
# works on a bare BusyBox.
machines_list() { # -> "id<TAB>name" per line
	if command -v jq >/dev/null 2>&1; then
		printf '%s' "$HTTP_BODY" | jq -r '.machines[]? | "\(.id)\t\(.name)"'
	elif command -v python3 >/dev/null 2>&1; then
		printf '%s' "$HTTP_BODY" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for m in d.get("machines") or []:
    print("%s\t%s" % (m.get("id", ""), m.get("name", "")))'
	else
		printf '%s' "$HTTP_BODY" | awk '
			function getv(o, k,   s, r) {
				s = index(o, "\"" k "\":\"")
				if (s == 0) { return "" }
				r = substr(o, s + length(k) + 4)
				return substr(r, 1, index(r, "\"") - 1)
			}
			function emit(o,   id, nm) {
				id = getv(o, "id")
				nm = getv(o, "name")
				if (id != "") { print id "	" nm }
			}
			{
				line = $0
				i = index(line, "\"machines\":[")
				if (i > 0) { line = substr(line, i + 12) } else { line = "" }
				depth = 0; buf = ""; started = 0
				for (p = 1; p <= length(line); p++) {
					c = substr(line, p, 1)
					if (c == "]") { if (depth == 0 && started == 1) { break } }
					if (c == "{") {
						depth++
						if (depth == 1) { buf = "{"; started = 1 } else { buf = buf c }
					} else {
						if (c == "}") {
							if (depth == 1) { emit(buf "}"); buf = "" } else { if (depth > 1) { buf = buf c } }
							depth--
						} else {
							if (depth >= 1) { buf = buf c }
						}
					}
				}
			}'
	fi
}

resolve() {
	if [ "$ALL" -eq 1 ]; then
		return 0
	fi
	case "$MACHINE" in
		m_*) MID=$MACHINE; LABEL=$MACHINE; return 0 ;;
	esac
	http GET "/v1/machines/$MACHINE" || { log "找不到机器 $MACHINE（HTTP $HTTP_CODE）: $HTTP_BODY"; return 1; }
	MID=$(jget "$HTTP_BODY" id)
	[ -n "$MID" ] || { log "没解析出机器 id: $HTTP_BODY"; return 1; }
	LABEL="$MACHINE（$MID）"
	return 0
}

preflight() {
	[ -n "$KEY" ] || die "未设置 INSTABOX_API_KEY（或 key=…）"
	if [ "$ALL" -eq 0 ]; then
		[ -n "$MACHINE" ] || die "未设置 INSTABOX_MACHINE（填名字、填 all、或留空表示全部）"
	fi
	case "$TTL" in ''|*[!0-9]*) die "TTL 必须是数字: $TTL" ;; esac
	if [ "$TTL" -lt 30 ] || [ "$TTL" -gt 3600 ]; then
		die "TTL 必须在 30-3600 秒之间（当前 $TTL）"
	fi
	resolve || exit 1
}

renew_one() { # renew_one <id> <label>
	if ! http PUT "/v1/machines/$1/activity-leases/$LEASE" "{\"ttlSeconds\":$TTL}"; then
		log "续租失败 $2/$LEASE HTTP $HTTP_CODE: $HTTP_BODY"
		return 1
	fi
	log "续租 ok $2/$LEASE 到期 $(jget "$HTTP_BODY" expiresAt)"
	return 0
}

release_one() { # release_one <id> <label>
	if http DELETE "/v1/machines/$1/activity-leases/$LEASE"; then
		log "已释放租约 $2/$LEASE"
		return 0
	fi
	if [ "$HTTP_CODE" = "404" ]; then
		log "租约本来就不存在 $2/$LEASE"
		return 0
	fi
	log "释放失败 $2/$LEASE HTTP $HTTP_CODE: $HTTP_BODY"
	return 1
}

status_one() { # status_one <id> <label>
	if ! http GET "/v1/machines/$1"; then
		log "读机器失败 $2 HTTP $HTTP_CODE: $HTTP_BODY"
		return 1
	fi
	log "$2 state=$(jget "$HTTP_BODY" state) \
autoSuspendAfterSeconds=$(jget "$HTTP_BODY" autoSuspendAfterSeconds) \
autoSuspendedAt=$(jget "$HTTP_BODY" autoSuspendedAt)"
	return 0
}

each_machine() { # each_machine <fn> -- run fn on the selected machine(s)
	fn=$1
	if [ "$ALL" -eq 0 ]; then
		"$fn" "$MID" "$LABEL"
		return $?
	fi
	if ! http GET "/v1/machines"; then
		log "列机器失败 HTTP $HTTP_CODE: $HTTP_BODY"
		return 1
	fi
	list=$(machines_list) || { log "解析机器列表失败"; return 1; }
	count=$(printf '%s\n' "$list" | grep -c . || true)
	if [ "${count:-0}" -eq 0 ]; then
		log "这把 key 名下没有机器"
		return 1
	fi
	bad=0
	printf '%s\n' "$list" | while IFS='	' read -r id name; do
		[ -n "$id" ] || continue
		"$fn" "$id" "${name:-$id}" || bad=$((bad + 1))
	done
	return 0
}

renew()   { preflight && each_machine renew_one; }
release() { preflight && each_machine release_one; }
status()  { preflight && each_machine status_one; }

CMD=${1:-}
[ -n "$CMD" ] || CMD=--watch
case "$CMD" in
	--once)    renew ;;
	--release) release ;;
	--status)  status ;;
	--watch|-w)
		preflight
		if [ "$ALL" -eq 1 ]; then TARGET="全部机器（按 key 自动发现）"; else TARGET=$LABEL; fi
		log "watch: 每 ${RENEW}s 续租 $TARGET/$LEASE（ttl ${TTL}s），API $API"
		while :; do
			renew || log "这一轮有失败，下一轮再试"
			sleep "$RENEW"
		done
		;;
	-h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//' ;;
	*)         echo "用法: $0 [--watch|--once|--status|--release|--help]" >&2; exit 2 ;;
esac
