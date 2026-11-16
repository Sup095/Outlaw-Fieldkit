#!/bin/sh
# FieldKit runner :: keep the tailnet-bound helpers running.
#
#   sh keepalive.sh            start any that Docker could not start
#   sh keepalive.sh install    run it from this user's crontab (every 5 minutes, and at boot)
#   sh keepalive.sh remove     take it out of the crontab
#
# The browser helper (browser-card.sh) and the small AI models (tiny-ai.sh)
# listen only on this machine's tailnet address. At boot Docker starts
# before Tailscale has that address, fails to bind it, and gives up on the
# container for good (exit 255, "cannot assign requested address"), even
# with --restart unless-stopped: after the reboot of 2026-11-08 both AI
# models stayed down until someone noticed. This starts them again once
# the address is there. It only touches containers Docker itself failed to
# start (exit 255, or created and never started); one somebody stopped on
# purpose stays stopped. No sudo needed, only the docker group.
set -u

if [ "${1:-}" = "install" ] || [ "${1:-}" = "remove" ]; then
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  LOG="$HOME/fk-keepalive.log"
  { crontab -l 2>/dev/null | grep -v "# fk-keepalive$"
    if [ "$1" = "install" ]; then
      echo "*/5 * * * * sh $SELF >> $LOG 2>&1 # fk-keepalive"
      echo "@reboot sleep 60; sh $SELF >> $LOG 2>&1 # fk-keepalive"
    fi
  } | crontab -
  echo "keepalive: ${1}ed (crontab of $(id -un))"
  exit 0
fi

command -v docker >/dev/null 2>&1 || exit 0
command -v tailscale >/dev/null 2>&1 && { tailscale ip -4 >/dev/null 2>&1 || exit 0; }   # no address yet: the next run

docker ps -a --format '{{.Names}} {{.State}}' | while read -r name state; do
  case "$name" in fk-browser-card|fk-ai-*) ;; *) continue ;; esac
  [ "$state" = "running" ] || [ "$state" = "restarting" ] && continue
  code="$(docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null || echo x)"
  if [ "$state" = "created" ] || [ "$code" = "255" ]; then
    if docker start "$name" >/dev/null 2>&1; then echo "$(date -u +%FT%TZ) started $name (was $state, exit $code)"
    else echo "$(date -u +%FT%TZ) could not start $name yet (was $state, exit $code)"; fi
  fi
done

# The log stays small: the last 200 lines.
LOG="$HOME/fk-keepalive.log"
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 400 ]; then tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
exit 0
