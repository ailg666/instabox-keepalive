#!/bin/sh
# Remove everything install.sh put on this machine.
#
#   sh uninstall.sh                 stop+remove service, release the lease, delete the dir
#   sh uninstall.sh --keep-files    stop+remove service, release the lease, keep the dir
#   sh uninstall.sh --keep-lease    leave the lease alone (it expires on its own)
#
# The service name comes from $DIR/install.conf (written at install time), so an
# uninstall never guesses. A unit is only removed when it actually references
# this install dir — running uninstall must never take down somebody else's
# service that happens to share the default name.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVICE=${SERVICE_NAME:-}
if [ -z "$SERVICE" ] && [ -f "$DIR/install.conf" ]; then
	# shellcheck disable=SC1091
	SERVICE=$(sed -n 's/^INSTABOX_SERVICE=//p' "$DIR/install.conf" | head -n 1)
fi
[ -n "$SERVICE" ] || SERVICE=instabox-keepalive

KEEP_FILES=0
KEEP_LEASE=0
for a in "$@"; do
	case "$a" in
		--keep-files) KEEP_FILES=1 ;;
		--keep-lease) KEEP_LEASE=1 ;;
		*) echo "未知参数: $a" >&2; exit 2 ;;
	esac
done

if [ "$(id -u)" -ne 0 ]; then
	echo "需要 root" >&2
	exit 1
fi

# 1) supervisor ---------------------------------------------------------------
UNIT=/etc/systemd/system/$SERVICE.service
if [ -f "$UNIT" ]; then
	if grep -qF "$DIR/keepalive.sh" "$UNIT"; then
		systemctl disable --now "$SERVICE.service" >/dev/null 2>&1 || true
		rm -f "$UNIT"
		systemctl daemon-reload
		echo "  已停止并删除 systemd 服务 $SERVICE"
	else
		echo "  跳过 systemd 服务 $SERVICE：它不指向 $DIR"
	fi
fi
INIT=/etc/init.d/$SERVICE
if [ -f "$INIT" ]; then
	if grep -qF "$DIR/keepalive.sh" "$INIT"; then
		rc-service "$SERVICE" stop >/dev/null 2>&1 || true
		rc-update del "$SERVICE" default >/dev/null 2>&1 || true
		rm -f "$INIT"
		echo "  已停止并删除 OpenRC 服务 $SERVICE"
	else
		echo "  跳过 OpenRC 服务 $SERVICE：它不指向 $DIR"
	fi
fi
if command -v crontab >/dev/null 2>&1; then
	BEFORE=$(crontab -l 2>/dev/null || true)
	AFTER=$(printf '%s\n' "$BEFORE" | grep -vF "$DIR/keepalive.sh" | grep -v '^$' || true)
	if [ "$AFTER" != "$BEFORE" ]; then
		printf '%s\n' "$AFTER" | crontab -
		echo "  已删除 cron 条目"
	fi
fi

# 2) lease --------------------------------------------------------------------
if [ "$KEEP_LEASE" -eq 0 ] && [ -f "$DIR/keepalive.sh" ] && [ -f "$DIR/.env" ]; then
	INSTABOX_ENV_FILE="$DIR/.env" sh "$DIR/keepalive.sh" --release || true
fi

# 3) files --------------------------------------------------------------------
if [ "$KEEP_FILES" -eq 0 ]; then
	rm -rf "$DIR"
	echo "  已删除 $DIR"
else
	echo "  保留 $DIR"
fi
