#!/bin/sh
# InstaBox keepalive installer — one line, no key ever written to the repo:
#
#   key=ibk_xxx machine=qqq bash <(curl -Ls https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main/install.sh)
#
# Works on Debian/Ubuntu (systemd) and Alpine (OpenRC, or cron as a fallback).
# Needs curl only; an idle box keeps the key in a 0600 .env next to the script.
#
# Env / flags (flags win):
#   key= / KEY= / INSTABOX_API_KEY=   api key (required)
#   machine= / INSTABOX_MACHINE=      box name or m_... id (required)
#   --lease NAME      lease name                  (default keepalive)
#   --ttl SECONDS     lease ttl, 30-3600          (default 300)
#   --dir PATH        install dir                 (default /root/instabox-keepalive)
#   --service NAME    service name                (default instabox-keepalive)
#   --raw URL         raw base for keepalive.sh   (default this repo, main)
#   --no-start        install but do not start
#   --cron            force the cron install path
#   --uninstall       remove everything (see uninstall.sh)
set -eu

RAW=${RAW_BASE:-https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main}
DIR=${INSTALL_DIR:-/root/instabox-keepalive}
SERVICE=${SERVICE_NAME:-instabox-keepalive}
LEASE=${INSTABOX_LEASE:-keepalive}
TTL=${INSTABOX_LEASE_TTL:-300}
NAME=${machine:-${INSTABOX_MACHINE:-}}
API_KEY=${key:-${KEY:-${IBK:-${INSTABOX_API_KEY:-}}}}
WANT_START=1
FORCE_CRON=0

while [ $# -gt 0 ]; do
	case "$1" in
		key=*)       API_KEY=${1#key=}; shift ;;
		machine=*)   NAME=${1#machine=}; shift ;;
		--key)       API_KEY=$2; shift 2 ;;
		--machine)   NAME=$2; shift 2 ;;
		--lease)     LEASE=$2; shift 2 ;;
		--ttl)       TTL=$2; shift 2 ;;
		--dir)       DIR=$2; shift 2 ;;
		--service)   SERVICE=$2; shift 2 ;;
		--raw)       RAW=$2; shift 2 ;;
		--no-start)  WANT_START=0; shift ;;
		--cron)      FORCE_CRON=1; shift ;;
		--uninstall) exec sh "$DIR/uninstall.sh" ;;
		-h|--help)   sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*)           echo "未知参数: $1" >&2; exit 2 ;;
	esac
done

say() { printf '  %s\n' "$*"; }
die() { printf '错误: %s\n' "$*" >&2; exit 1; }
mask() { v=$1; n=${#v}; if [ "$n" -le 12 ]; then echo "$v"; else echo "$(printf %s "$v" | cut -c1-8)……$(printf %s "$v" | cut -c$((n - 3))-$n)"; fi; }

# ---- run as root ------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
	if [ -f "$0" ] && command -v sudo >/dev/null 2>&1; then
		exec sudo -E sh "$0" key="$API_KEY" machine="$NAME" \
			--lease "$LEASE" --ttl "$TTL" --dir "$DIR" --service "$SERVICE" --raw "$RAW"
	fi
	cat >&2 <<'EOF'
错误: 需要 root 权限。
  以 root 跑:  key=ibk_xxx machine=qqq bash <(curl -Ls <raw-url>/install.sh)
  非 root 用:  curl -Ls <raw-url>/install.sh | sudo -E env key=ibk_xxx machine=qqq sh
EOF
	exit 1
fi

[ -n "$API_KEY" ] || die "缺少 key（key=ibk_... 或 --key 之前用环境变量传入）"
[ -n "$NAME" ]    || die "缺少 machine（machine=qqq）"
case "$TTL" in ''|*[!0-9]*) die "ttl 必须是数字" ;; esac
[ "$TTL" -ge 30 ] && [ "$TTL" -le 3600 ] || die "ttl 必须在 30-3600 秒之间"

# ---- deps -------------------------------------------------------------------
if ! command -v curl >/dev/null 2>&1; then
	if command -v apk >/dev/null 2>&1; then apk add --no-cache curl >/dev/null
	elif command -v apt-get >/dev/null 2>&1; then apt-get update -qq >/dev/null && apt-get install -y -qq curl >/dev/null
	elif command -v dnf >/dev/null 2>&1; then dnf install -y -q curl >/dev/null
	else die "缺 curl 且不认识包管理器，请先装 curl"; fi
fi

# ---- fetch payload ----------------------------------------------------------
# A local checkout wins over the network; `bash <(curl …)` has no real dirname.
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo /nonexistent)
fetch() { # fetch <name> <dest>
	if [ -f "$SELF_DIR/$1" ] && [ "$SELF_DIR" != "$DIR" ]; then
		cp -f "$SELF_DIR/$1" "$2"
	elif [ -f "$DIR/$1" ]; then
		:
	else
		curl -fsSL -m 60 -o "$2" "$RAW/$1" || die "下载 $1 失败（$RAW/$1）"
	fi
}

mkdir -p "$DIR"
chmod 700 "$DIR"
fetch keepalive.sh "$DIR/keepalive.sh"
fetch uninstall.sh "$DIR/uninstall.sh"
chmod 755 "$DIR/keepalive.sh" "$DIR/uninstall.sh"

printf 'INSTABOX_API_KEY=%s\nINSTABOX_MACHINE=%s\nINSTABOX_LEASE=%s\nINSTABOX_LEASE_TTL=%s\n' \
	"$API_KEY" "$NAME" "$LEASE" "$TTL" > "$DIR/.env"
chmod 600 "$DIR/.env"
printf 'INSTABOX_SERVICE=%s\nINSTABOX_DIR=%s\n' "$SERVICE" "$DIR" > "$DIR/install.conf"
printf 'instabox-keepalive\n' > "$DIR/.gitignore"

# ---- smoke test: the lease must renew before we install anything ------------
printf '检查 key 与机器…\n'
if ! INSTABOX_ENV_FILE="$DIR/.env" sh "$DIR/keepalive.sh" --once; then
	die "续租失败，未安装。检查 key/machine 是否正确、是否有 machines:write 权限"
fi
INSTABOX_ENV_FILE="$DIR/.env" sh "$DIR/keepalive.sh" --status || true

# ---- install the supervisor -------------------------------------------------
start_service() {
	# 1) systemd
	if [ "$FORCE_CRON" -eq 0 ] && command -v systemctl >/dev/null 2>&1 \
		&& [ "$(cat /proc/1/comm 2>/dev/null || echo none)" = systemd ]; then
		cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=InstaBox keepalive (renews the $LEASE activity lease)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/sh $DIR/keepalive.sh --watch
EnvironmentFile=$DIR/.env
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
		systemctl daemon-reload
		systemctl enable --now "$SERVICE.service" >/dev/null 2>&1
		say "systemd: $SERVICE.service 已 enable --now"
		return 0
	fi

	# 2) OpenRC (Alpine)
	if [ "$FORCE_CRON" -eq 0 ] && { command -v rc-update >/dev/null 2>&1 || [ -x /sbin/openrc ]; }; then
		cat > "/etc/init.d/$SERVICE" <<EOF
#!/sbin/openrc-run
name="$SERVICE"
description="InstaBox keepalive (renews the $LEASE activity lease)"

command=/bin/sh
command_args="$DIR/keepalive.sh --watch"
command_background=true
pidfile=/run/$SERVICE.pid
output_log=/var/log/$SERVICE.log
error_log=/var/log/$SERVICE.log

depend() {
	need net
	after firewall
}
EOF
		chmod 755 "/etc/init.d/$SERVICE"
		rc-update add "$SERVICE" default >/dev/null 2>&1 || true
		rc-service "$SERVICE" restart >/dev/null 2>&1 || rc-service "$SERVICE" start >/dev/null 2>&1 || true
		say "OpenRC: /etc/init.d/$SERVICE 已加到 default"
		return 0
	fi

	# 3) cron (@reboot + every N minutes)
	MIN=$((TTL / 60)); [ "$MIN" -lt 1 ] && MIN=1; [ "$MIN" -gt 30 ] && MIN=30
	LINE="*/$MIN * * * * INSTABOX_ENV_FILE=$DIR/.env /bin/sh $DIR/keepalive.sh --once >/dev/null 2>&1"
	( crontab -l 2>/dev/null | grep -vF "$DIR/keepalive.sh" | grep -v '^$' || true ; echo "$LINE" ) | crontab -
	say "cron: 每 $MIN 分钟续租一次"
	if command -v rc-service >/dev/null 2>&1; then
		rc-update add crond default >/dev/null 2>&1 || true
		rc-service crond start >/dev/null 2>&1 || true
	fi
	return 0
}

if [ "$WANT_START" -eq 1 ]; then
	start_service
else
	printf '  --no-start: 未安装服务，手动跑: INSTABOX_ENV_FILE=%s/.env sh %s/keepalive.sh --watch\n' "$DIR" "$DIR"
fi

cat <<EOF

  安装完成
    目录   $DIR          （.env 权限 600，key 不落仓库、不进进程列表）
    机器   $NAME
    租约   $LEASE，ttl ${TTL}s
    key    $(mask "$API_KEY")
    卸载   sh $DIR/uninstall.sh
    状态   sh $DIR/keepalive.sh --status
EOF
