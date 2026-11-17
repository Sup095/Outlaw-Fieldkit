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
# start (exit 255, or created and never started) or started without their
# port; one somebody stopped on purpose stays stopped. No sudo needed, only
# the docker group.
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

HERE="$(cd "$(dirname "$0")" && pwd)"
now() { date -u +%FT%TZ; }
# The ports a container was given but does not have. Docker 29 does not
# always give up at boot: it may start the container WITHOUT its port (log:
# "Failed to allocate port"), so it reads "Up (healthy)" while nothing can
# reach it, and it stays that way through restarts (found 2026-11-17). Only
# a new container binds it again, so that is what this asks for.
portless() {
  want="$(docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{$p}} {{end}}' "$1" 2>/dev/null)"
  [ -n "$want" ] && [ -z "$(docker port "$1" 2>/dev/null)" ]
}

REDO=""
for row in $(docker ps -a --format '{{.Names}}|{{.State}}'); do
  name="${row%%|*}"; state="${row#*|}"
  case "$name" in fk-browser-card|fk-ai-*) ;; *) continue ;; esac
  [ "$state" = "restarting" ] && continue
  if [ "$state" != "running" ]; then
    code="$(docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null || echo x)"
    [ "$state" = "created" ] || [ "$code" = "255" ] || continue
    if docker start "$name" >/dev/null 2>&1; then echo "$(now) started $name (was $state, exit $code)"
    else echo "$(now) could not start $name yet (was $state, exit $code)"; continue; fi
  fi
  if portless "$name"; then
    echo "$(now) $name is running without its port: making it again"
    case "$name" in fk-ai-*) REDO="$REDO ai" ;; *) REDO="$REDO card" ;; esac
  fi
done

# Made again by the script that made it, with the same settings it had.
case "$REDO" in *ai*)
  if [ -f "$HERE/tiny-ai.sh" ]; then sh "$HERE/tiny-ai.sh" >/dev/null 2>&1 && echo "$(now) AI models made again" || echo "$(now) tiny-ai.sh failed"
  else echo "$(now) tiny-ai.sh is not next to keepalive.sh"; fi ;; esac
case "$REDO" in *card*)
  if [ -f "$HERE/browser-card.sh" ]; then sh "$HERE/browser-card.sh" >/dev/null 2>&1 && echo "$(now) browser helper made again" || echo "$(now) browser-card.sh failed"
  else echo "$(now) browser-card.sh is not next to keepalive.sh"; fi ;; esac

# The log stays small: the last 200 lines.
LOG="$HOME/fk-keepalive.log"
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 400 ]; then tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
exit 0
