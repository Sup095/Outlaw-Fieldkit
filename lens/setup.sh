#!/bin/sh
# FieldKit lens: install or update the lens server on the rented machine.
#
#   sudo sh lens/lens/setup.sh <relay address> <this server's name>
#   e.g.  sudo sh lens/lens/setup.sh https://relay.example.com lens.example.com
#
# Run from the folder deploy/lens.tar.gz unpacks to. Safe to run again:
# that is how an update is done. What it does:
#   - builds the image fieldkit-lens:1 (our code, and Scramjet's client
#     files at the versions and hashes lens/vendor pins);
#   - writes /srv/lens/config.json the first time only (edit it there);
#   - runs the container read-only, without privileges, on 127.0.0.1:8080;
#   - puts Caddy in front of it for the certificate and https;
#   - turns on nightly security updates, with a reboot at 04:30 when one
#     needs it (everything here starts again by itself).
# The machine's own setup (user, SSH, firewall, swap) was done by hand
# once and is in FIELDKIT_PROJECT.md §14.51.
set -eu

RELAY="${1:-}"
HOST="${2:-}"
if [ -z "$RELAY" ] || [ -z "$HOST" ]; then
  echo "usage: sudo sh $0 <relay address> <this server's name>" >&2
  exit 2
fi
case "$RELAY" in https://*) ;; *) echo "the relay address must start with https://" >&2; exit 2 ;; esac
case "$HOST" in *[!a-z0-9.-]*|"") echo "the server's name looks wrong: $HOST" >&2; exit 2 ;; esac

DIR="$(cd "$(dirname "$0")/.." && pwd)"
ETC=/srv/lens
UID_NODE=1000

echo "== image"
docker build -q -t fieldkit-lens:1 "$DIR" >/dev/null
docker image prune -f >/dev/null

echo "== config"
mkdir -p "$ETC/data"
chown -R "$UID_NODE:$UID_NODE" "$ETC/data"
if [ ! -f "$ETC/config.json" ]; then
  cat > "$ETC/config.json" <<EOF
{
  "host": "127.0.0.1",
  "port": 8080,
  "relayUrl": "$RELAY",
  "dataDir": "/data",
  "clientDir": "/opt/fieldkit/lens/client",
  "dnsFilter": "adult",
  "capBytes": 1700000000000,
  "personDayBytes": 15000000000,
  "maxPerWho": 4,
  "trustProxy": "loopback",
  "providerTokenFile": "/etc/lens/provider-token"
}
EOF
  echo "wrote $ETC/config.json"
else
  echo "kept $ETC/config.json"
fi
# The month's ceiling counts the provider's figure for the whole machine,
# full mode's pictures included. The Nanode's 1.7 TB, on the 4 GB plan
# (4 TB included, then $0.005 a GB), becomes 6 TB: at most $10 over the
# plan's $24, so the month stays under $34.
if [ "$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)" -ge 3500 ] && grep -q '"capBytes": 1700000000000' "$ETC/config.json"; then
  sed -i 's/"capBytes": 1700000000000/"capBytes": 6000000000000/' "$ETC/config.json"
  echo "raised the month's ceiling to 6 TB for the 4 GB plan"
fi
TOKEN_MOUNT=""
if [ -f "$ETC/provider-token" ]; then
  chown "$UID_NODE:$UID_NODE" "$ETC/provider-token"
  chmod 600 "$ETC/provider-token"
  TOKEN_MOUNT="-v $ETC/provider-token:/etc/lens/provider-token:ro"
fi

echo "== container"
docker rm -f fk-lens >/dev/null 2>&1 || true
# shellcheck disable=SC2086
docker run -d --name fk-lens --restart unless-stopped \
  --network host --read-only --tmpfs /tmp:size=32m \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 600m --memory-swap 800m --cpus 0.9 --pids-limit 256 \
  -v "$ETC/data:/data" -v "$ETC/config.json:/etc/lens/config.json:ro" $TOKEN_MOUNT \
  fieldkit-lens:1 >/dev/null

echo "== full mode"
# BROWSER's full mode on this same machine (SIMPLIFY_PLAN.md §14): the
# relay's own image as a CLOUD browser helper. Panels connect to it
# directly, so its pictures never cross the home connection. A
# Chromium session needs about 450 MB, so this runs only on the 4 GB
# plan or larger; on the Nanode it says so and leaves it off.
MEM_MB=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
CPUS=$(nproc)
if [ -f "$DIR/full/Dockerfile" ] && [ -f "$DIR/full/config.json" ] && [ "$MEM_MB" -ge 3500 ]; then
  FULL_MB=$((MEM_MB - 1100))                 # lens 600, the system and Caddy 500
  MAX=$((FULL_MB / 450)); [ "$MAX" -gt $((CPUS * 2)) ] && MAX=$((CPUS * 2))
  docker build -q -t fieldkit-relay:1 "$DIR/full" >/dev/null
  mkdir -p /srv/full
  sed -e "s#\"publicUrl\": \"[^\"]*\"#\"publicUrl\": \"https://$HOST\"#" \
      -e "s#\"maxSessions\": [0-9]*#\"maxSessions\": $MAX#" "$DIR/full/config.json" > /srv/full/config.json
  chmod 644 /srv/full/config.json
  docker rm -f fk-full >/dev/null 2>&1 || true
  docker run -d --name fk-full --restart unless-stopped \
    --read-only --user 999:999 --cap-drop ALL --security-opt no-new-privileges \
    --memory "${FULL_MB}m" --memory-swap "$((FULL_MB + 1024))m" --cpus "$CPUS" --cpu-shares 512 --pids-limit 4096 \
    --tmpfs /home/container:rw,exec,size=512m,uid=999,gid=999 --tmpfs /tmp:rw,size=512m,mode=1777 --shm-size 1g \
    -e FK_BROWSER_TMP=/dev/shm \
    -v /srv/full/config.json:/home/container/config.json:ro \
    -p 127.0.0.1:8090:8080 \
    --log-opt max-size=10m --log-opt max-file=3 \
    --entrypoint node fieldkit-relay:1 /opt/fieldkit/relay/start.js >/dev/null
  echo "full mode: up to $MAX sessions in ${FULL_MB} MB"
else
  docker rm -f fk-full >/dev/null 2>&1 || true
  echo "full mode: off (this machine has ${MEM_MB} MB; it needs the 4 GB plan or larger)"
fi

echo "== caddy"
sed "s/LENS_HOST/$HOST/" "$DIR/lens/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || { echo "the Caddyfile did not validate" >&2; exit 1; }
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "== updates"
cat > /etc/apt/apt.conf.d/52fieldkit-lens <<EOF
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF

echo "== check"
i=0
until curl -fsS http://127.0.0.1:8080/lens/status >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 20 ] && { echo "lens did not answer; docker logs fk-lens says:" >&2; docker logs --tail 20 fk-lens >&2; exit 1; }
  sleep 1
done
echo "lens:  $(curl -fsS http://127.0.0.1:8080/lens/status)"
echo "https: $(curl -fsS -o /dev/null -w '%{http_code}' --max-time 60 "https://$HOST/lens/status" || echo 'not yet (the certificate can take a minute)')"
if docker ps --format '{{.Names}}' | grep -qx fk-full; then
  i=0
  until curl -fsS http://127.0.0.1:8090/health >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 30 ] && { echo "full mode did not answer; docker logs fk-full says:" >&2; docker logs --tail 20 fk-full >&2; exit 1; }
    sleep 1
  done
  echo "full:  $(curl -fsS http://127.0.0.1:8090/health)"
fi
