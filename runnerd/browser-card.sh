#!/bin/sh
# FieldKit runner :: a browser helper with the graphics card (relay/browser-helper.js).
#
#   sh browser-card.sh [config.json]    start it, or restart it with new settings
#   sh browser-card.sh stop             stop it
#
# Pages here are drawn on the Quadro and their video is encoded on it, so a
# session costs a fraction of what it does anywhere else. It needs the card,
# which a Pterodactyl server cannot be given, so this is a plain container
# beside RUNNER. No sudo needed, only the docker group.
#
# Only approved accounts are sent here: the relay decides, and the helper
# refuses a guest as well. The card is not behind gVisor (the K2200 cannot
# be), so what stands between a page and the driver is Chromium, no root, no
# capabilities and no new privileges. To stop using the card, run "stop":
# sessions go back to the relay and the Pterodactyl helper.
#
# The port is on this machine's tailnet address only: nobody but the relay
# should reach it, and it believes nothing the relay did not sign.
set -eu

NAME=fk-browser-card
DIR="${BROWSER_CARD_DIR:-$HOME/browser-card}"
IMAGE="${BROWSER_CARD_IMAGE:-fieldkit-relay:1}"
PORT="${BROWSER_CARD_PORT:-25571}"

if [ "${1:-}" = "stop" ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  echo "stopped"
  exit 0
fi

mkdir -p "$DIR"
if [ -n "${1:-}" ]; then cp "$1" "$DIR/config.json"; fi
[ -f "$DIR/config.json" ] || { echo "no config: pass deploy/helper-upload/config.json"; exit 1; }
ADDR="$(tailscale ip -4 2>/dev/null | head -1)"
[ -n "$ADDR" ] || { echo "no tailnet address on this machine"; exit 1; }

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  --gpus all -e NVIDIA_DRIVER_CAPABILITIES=all \
  --user 999:999 --group-add video --cap-drop ALL --security-opt no-new-privileges \
  --memory 14g --pids-limit 4096 --cpu-shares 1024 \
  --tmpfs /home/container:rw,exec,size=512m,uid=999,gid=999 --tmpfs /tmp:rw,size=1g,mode=1777 --shm-size 6g \
  -e FK_BROWSER_TMP=/dev/shm \
  -v "$DIR/config.json:/home/container/config.json:ro" \
  -p "$ADDR:$PORT:8080" \
  --log-opt max-size=10m --log-opt max-file=3 \
  --entrypoint node "$IMAGE" /opt/fieldkit/relay/start.js >/dev/null

echo "running at http://$ADDR:$PORT"
echo "the relay's browser.helpers should list that address"
