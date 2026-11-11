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
  # The relay's addresses change when a blocked one is deleted from the
  # tunnel, so this run's list replaces the one in the kept file.
  sed -i "s#\"relayUrl\": *\"[^\"]*\"#\"relayUrl\": \"$RELAY\"#" "$ETC/config.json"
  echo "kept $ETC/config.json (relayUrl: $RELAY)"
fi
TOKEN_MOUNT=""
if [ -f "$ETC/provider-token" ]; then
  chown "$UID_NODE:$UID_NODE" "$ETC/provider-token"
  chmod 600 "$ETC/provider-token"
  TOKEN_MOUNT="-v $ETC/provider-token:/etc/lens/provider-token:ro"
fi

echo "== warp"
# YouTube refuses this server's address and plays for Cloudflare WARP's
# (FIELDKIT_PROJECT.md §14.53). fk-warp is a WARP tunnel in a container of
# its own, with a SOCKS5 door on 127.0.0.1:1080; lens/egress.js sends only
# YouTube's connections through it. Bought proxy addresses can stand in or
# add to it: they go in $ETC/egress.json, which is kept once written.
docker build -q -t fieldkit-warp:1 -f "$DIR/lens/warp/Dockerfile" "$DIR" >/dev/null
mkdir -p "$ETC/warp"
chmod 700 "$ETC/warp"
docker rm -f fk-warp >/dev/null 2>&1 || true
docker run -d --name fk-warp --restart unless-stopped \
  --cap-drop ALL --cap-add NET_ADMIN --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges \
  --sysctl net.ipv4.conf.all.src_valid_mark=1 --dns 1.1.1.1 \
  --read-only --tmpfs /tmp:size=4m \
  --memory 128m --memory-swap 160m --cpus 0.5 --pids-limit 64 \
  -v "$ETC/warp:/data" -p 127.0.0.1:1080:1080 \
  --log-opt max-size=5m --log-opt max-file=2 \
  fieldkit-warp:1 >/dev/null
if [ ! -f "$ETC/egress.json" ]; then
  cat > "$ETC/egress.json" <<EOF
{
  "proxies": ["socks5://127.0.0.1:1080"]
}
EOF
  echo "wrote $ETC/egress.json (YouTube through WARP)"
else
  echo "kept $ETC/egress.json"
fi
chown "$UID_NODE:$UID_NODE" "$ETC/egress.json"
chmod 600 "$ETC/egress.json"
grep -q '"egressFile"' "$ETC/config.json" || sed -i '0,/{/s//{\n  "egressFile": "\/etc\/lens\/egress.json",/' "$ETC/config.json"
# 0.9.0's full mode on this machine is gone (SIMPLIFY_PLAN.md §15).
docker rm -f fk-full >/dev/null 2>&1 || true
docker image rm fieldkit-relay:1 >/dev/null 2>&1 || true
rm -rf /srv/full

echo "== container"
docker rm -f fk-lens >/dev/null 2>&1 || true
# shellcheck disable=SC2086
docker run -d --name fk-lens --restart unless-stopped \
  --network host --read-only --tmpfs /tmp:size=32m \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 600m --memory-swap 800m --cpus 0.9 --pids-limit 256 \
  -v "$ETC/data:/data" -v "$ETC/config.json:/etc/lens/config.json:ro" $TOKEN_MOUNT \
  -v "$ETC/egress.json:/etc/lens/egress.json:ro" \
  fieldkit-lens:1 >/dev/null

echo "== caddy"
sed "s/LENS_HOST/$HOST/g" "$DIR/lens/Caddyfile" > /etc/caddy/Caddyfile
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
echo "warp:  $(docker logs fk-warp 2>&1 | grep -E 'warp: (up|no|Cloud)' | tail -1 || echo 'starting')"
echo "https: $(curl -fsS -o /dev/null -w '%{http_code}' --max-time 60 "https://$HOST/lens/status" || echo 'not yet (the certificate can take a minute)')"
