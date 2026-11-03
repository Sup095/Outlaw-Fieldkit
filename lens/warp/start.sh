#!/bin/sh
# FieldKit lens :: fk-warp — a Cloudflare WARP tunnel with a SOCKS5 door.
#
# Runs as the container fk-warp (lens/setup.sh starts it). The container
# has its own network; this script makes WARP its only way out, then
# hands over to warp/socks.js as an unprivileged user. The host and lens
# are not touched: lens reaches the door on 127.0.0.1:1080.
#
# The WARP registration (a WireGuard key and Cloudflare's answer) is made
# once, with the same request Cloudflare's own WARP app makes, and kept
# in /data/reg.json (/srv/lens/warp on the host, root only).
set -eu

DATA=/data
REG="$DATA/reg.json"
API=https://api.cloudflareclient.com/v0a2158
HDR="CF-Client-Version: a-6.10-2158"

if [ ! -s "$REG" ]; then
  echo "warp: registering this server with Cloudflare WARP (once)"
  PRIV=$(wg genkey); PUB=$(echo "$PRIV" | wg pubkey)
  TOS=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  R=$(curl -fsS -m 30 -X POST "$API/reg" -H "Content-Type: application/json" -H "$HDR" -H "User-Agent: okhttp/3.12.1" \
    -d "{\"key\":\"$PUB\",\"install_id\":\"\",\"fcm_token\":\"\",\"tos\":\"$TOS\",\"type\":\"Android\",\"locale\":\"en_US\"}")
  ID=$(echo "$R" | jq -r '.result.id // .id // empty')
  TOKEN=$(echo "$R" | jq -r '.result.token // .token // empty')
  [ -n "$ID" ] && [ -n "$TOKEN" ] || { echo "warp: Cloudflare did not register us" >&2; exit 1; }
  R2=$(curl -fsS -m 30 -X PATCH "$API/reg/$ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "$HDR" -d '{"warp_enabled":true}')
  CFG=$(echo "$R2" | jq -c '.result.config // .config')
  umask 077
  jq -n --arg priv "$PRIV" --arg id "$ID" --arg token "$TOKEN" --argjson cfg "$CFG" '{priv: $priv, id: $id, token: $token, config: $cfg}' > "$REG.new"
  mv "$REG.new" "$REG"
fi

PRIV=$(jq -r .priv "$REG")
PEER=$(jq -r '.config.peers[0].public_key' "$REG")
ADDR=$(jq -r '.config.interface.addresses.v4' "$REG")
[ -n "$PEER" ] && [ "$PEER" != null ] && [ -n "$ADDR" ] && [ "$ADDR" != null ] || { echo "warp: $REG is incomplete; delete it to register again" >&2; exit 1; }

# WARP's well-known endpoint; the ports Cloudflare lists, tried in turn.
EP_IP=162.159.192.1
GW=$(ip route show default | awk '{print $3; exit}')
ip link del wg0 2>/dev/null || true
ip link add wg0 type wireguard
printf '%s\n' "$PRIV" > /tmp/k
wg set wg0 private-key /tmp/k
rm -f /tmp/k
ip addr add "$ADDR/32" dev wg0
ip link set wg0 up mtu 1280
ip route replace "$EP_IP/32" via "$GW"
ip route replace default dev wg0

OK=""
for P in 2408 500 1701 4500; do
  wg set wg0 peer "$PEER" endpoint "$EP_IP:$P" allowed-ips 0.0.0.0/0 persistent-keepalive 25
  if curl -fsS -m 8 -o /dev/null https://1.1.1.1/cdn-cgi/trace; then OK=$P; break; fi
done
[ -n "$OK" ] || { echo "warp: no WARP port answered" >&2; exit 1; }
echo "warp: up on port $OK as $(curl -fsS -m 8 https://1.1.1.1/cdn-cgi/trace | awk -F= '/^ip=/{print $2}')"

# Moving to an ordinary user clears every capability the tunnel needed.
exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all \
  node /opt/fieldkit/lens/warp/socks.js
