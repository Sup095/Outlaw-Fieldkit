#!/usr/bin/env bash
# FieldKit RUNNER :: setup.sh — sets up, or updates, the run server.
#
#     sudo bash bastion2/runnerd/setup.sh
#
# Safe to run again at any time: every step first checks whether it is
# already done. Running it again IS how you update.
#
# What it does, in order, and it says each one as it goes:
#   1. checks Docker is here
#   2. gives RUNNER its own fixed-size disk (so uploads can never fill
#      the system disk) — asks before creating it
#   3. installs gVisor, the extra wall between a job and this machine
#   4. builds the images jobs run in
#   5. writes the settings file (only if there is not one already)
#   6. starts the run server, and the tunnel if a token was given,
#      fk-power, which reads what the machine draws for ADMIN, and
#      fk-sleep, which puts it to sleep when RUNNER has nothing to do
#      (only once an admin switches that on in ADMIN)
#   7. checks it answers, and measures your upload speed
#
# Options (none are needed):
#   --relay URL            the FieldKit relay's address
#   --tunnel-token TOKEN   the Cloudflare Tunnel token for this machine
#   --store-gb N           size of RUNNER's disk in GB (default 250)
#   --no-gvisor            skip step 3 and use Docker's ordinary runtime
#   --no-wine              skip the Windows-program image (saves ~10 min)
#   --yes                  do not ask before creating the disk

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LC_ALL=C

HERE="$(cd "$(dirname "$0")/.." && pwd)"     # the unpacked bundle
BASE=/srv/fieldkit
APP="$BASE/app" ; STORE="$BASE/store" ; ETC="$BASE/etc"
RELAY_URL="" ; TUNNEL_TOKEN="" ; STORE_GB=250 ; GVISOR=1 ; WINE=1 ; YES=0
STEP="starting"

[ -f "$HERE/answers.env" ] && . "$HERE/answers.env"

while [ $# -gt 0 ]; do
  case "$1" in
    --relay) RELAY_URL="$2"; shift 2 ;;
    --tunnel-token) TUNNEL_TOKEN="$2"; shift 2 ;;
    --store-gb) STORE_GB="$2"; shift 2 ;;
    --no-gvisor) GVISOR=0; shift ;;
    --no-wine) WINE=0; shift ;;
    --yes) YES=1; shift ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m== %s\033[0m\n' "$1"; STEP="$1"; }
note() { printf '   %s\n' "$1"; }
warn() { printf '   \033[33mNOTE: %s\033[0m\n' "$1"; }
trap 'echo; echo "STOPPED during: $STEP"; echo "Nothing is half-finished in a way that matters: fix the message above and run the same command again."' ERR

[ "$(id -u)" = 0 ] || { echo "Run this with sudo:  sudo bash $0"; exit 1; }

say "1/7  Docker"
command -v docker >/dev/null || { echo "Docker is not installed. Install it first (sudo apt install docker.io) and run this again."; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is installed but not running:  sudo systemctl start docker"; exit 1; }
note "docker $(docker version --format '{{.Server.Version}}')"
if ! docker compose version >/dev/null 2>&1; then
  note "installing the compose plugin"
  apt-get update -qq
  apt-get install -y -qq docker-compose-v2 >/dev/null 2>&1 || apt-get install -y -qq docker-compose-plugin >/dev/null
fi
note "compose $(docker compose version --short)"

say "2/7  RUNNER's own disk"
mkdir -p "$BASE"
if mountpoint -q "$BASE"; then
  note "already there: $(df -h --output=size,avail "$BASE" | tail -1 | xargs) (size, free)"
elif command -v vgs >/dev/null && [ -n "$(vgs --noheadings -o vg_name 2>/dev/null | head -1 | xargs)" ]; then
  VG="$(vgs --noheadings -o vg_name | head -1 | xargs)"
  FREE_GB="$(vgs --noheadings --units g --nosuffix -o vg_free "$VG" | xargs | cut -d. -f1)"
  note "volume group $VG has ${FREE_GB} GB not used by anything"
  if [ "$FREE_GB" -lt 30 ]; then
    warn "not enough free space for a separate disk. Using a plain folder; uploads share the system disk."
    mkdir -p "$STORE"
  else
    [ "$STORE_GB" -gt $((FREE_GB - 20)) ] && STORE_GB=$((FREE_GB - 20))
    note "This creates a new ${STORE_GB} GB volume called 'fieldkit' and mounts it at $BASE."
    note "It uses only space that is currently unused. Nothing existing is resized or touched."
    if [ "$YES" != 1 ]; then
      read -r -p "   Create it? [y/N] " A </dev/tty
      [ "$A" = y ] || [ "$A" = Y ] || { echo "   Not created. Run again with --store-gb N to pick a size."; exit 1; }
    fi
    lvcreate -y -L "${STORE_GB}G" -n fieldkit "$VG" >/dev/null
    mkfs.ext4 -q -L fieldkit "/dev/$VG/fieldkit"
    grep -q "LABEL=fieldkit" /etc/fstab || echo "LABEL=fieldkit $BASE ext4 defaults,nodev,nosuid 0 2" >> /etc/fstab
    mount "$BASE"
    note "created and mounted: $(df -h --output=size "$BASE" | tail -1 | xargs)"
  fi
else
  warn "no LVM here, so RUNNER uses a plain folder and shares the system disk."
fi
mkdir -p "$STORE" "$ETC" "$APP"
chmod 700 "$ETC"

say "3/7  The copy of the app"
# Kept in one fixed place so an update is "unpack and run this again".
rm -rf "$APP.new" && mkdir -p "$APP.new"
cp -a "$HERE/relay" "$HERE/runnerd" "$APP.new/"
rm -rf "$APP.old" ; [ -d "$APP" ] && mv "$APP" "$APP.old" ; mv "$APP.new" "$APP" ; rm -rf "$APP.old"
note "in $APP"

say "4/7  The images jobs run in"
docker build -q -t fieldkit-runner:1 "$APP/runnerd/image" >/dev/null
note "fieldkit-runner:1 (scripts and Linux programs)"
WINE_IMAGE=""
if [ "$WINE" = 1 ]; then
  note "building the Windows-program image. The first time takes about ten minutes..."
  if docker build -q -t fieldkit-runner-wine:1 "$APP/runnerd/image-wine" >/dev/null; then
    WINE_IMAGE="fieldkit-runner-wine:1" ; note "fieldkit-runner-wine:1 (.exe files)"
  else
    warn "the Windows-program image did not build. Everything else still works; .exe files are off."
  fi
fi
# Programs with a window (phase 6): the Windows box plus a virtual
# screen, sound card and video encoder. Built on the Windows image,
# so only when that exists. runnerd finds it by its name.
if [ -n "$WINE_IMAGE" ]; then
  note "building the screen image (programs with a window), a few minutes the first time..."
  if docker build -q -t fieldkit-runner-screen:1 "$APP/runnerd/image-screen" >/dev/null; then
    note "fieldkit-runner-screen:1 (RUN IN WINDOW)"
  else
    warn "the screen image did not build. Everything else still works; RUN IN WINDOW is off."
  fi
fi

say "5/7  gVisor"
RUNTIME=""
if [ "$GVISOR" = 1 ]; then
  # Since October 2026 gVisor ships as one tarball: runsc, its
  # containerd shim, and a gvisor-bin/ folder of helpers (the Sentry
  # among them) that runsc will not start a sandbox without and looks
  # for next to itself. The old per-file URLs are gone (404).
  if ! command -v runsc >/dev/null || [ ! -x "$(dirname "$(command -v runsc)")/gvisor-bin/gvisor_sentry" ]; then
    ARCH="$(uname -m)" ; URL="https://storage.googleapis.com/gvisor/releases/release/latest/$ARCH"
    T="$(mktemp -d)"
    note "downloading gVisor from gvisor.dev's release bucket and checking its checksum"
    if ( cd "$T" && curl -fsSL -o gvisor.tar.bz2 "$URL/gvisor.tar.bz2" \
          && curl -fsSL -o gvisor.tar.bz2.sha512 "$URL/gvisor.tar.bz2.sha512" \
          && sha512sum -c gvisor.tar.bz2.sha512 >/dev/null \
          && mkdir x && tar xjf gvisor.tar.bz2 -C x \
          && [ -x x/runsc ] && [ -x x/containerd-shim-runsc-v1 ] && [ -x x/gvisor-bin/gvisor_sentry ] ); then
      install -m 0755 "$T/x/runsc" "$T/x/containerd-shim-runsc-v1" /usr/local/bin/
      rm -rf /usr/local/bin/gvisor-bin
      cp -r "$T/x/gvisor-bin" /usr/local/bin/gvisor-bin
      chmod -R a+rX,go-w /usr/local/bin/gvisor-bin
    else
      warn "could not download gVisor. Continuing without it."
    fi
    rm -rf "$T"
  fi
  if command -v runsc >/dev/null; then
    if ! docker info --format '{{json .Runtimes}}' | grep -q '"runsc"'; then
      [ -f /etc/docker/daemon.json ] && cp -n /etc/docker/daemon.json /etc/docker/daemon.json.before-fieldkit
      runsc install >/dev/null
      # A reload, not a restart: containers already running on this
      # machine are not interrupted.
      systemctl reload docker
      sleep 2
    fi
    GV_OUT="$(docker run --rm --runtime=runsc --network none fieldkit-runner:1 python3 -c 'print("ok")' 2>&1 || true)"
    if printf "%s" "$GV_OUT" | grep -qx ok; then
      RUNTIME="runsc" ; note "working: jobs run under gVisor ($(runsc --version | head -1))"
    else
      warn "gVisor is installed but a test job would not start under it (this kernel may be too new for it)."
      warn "what it said: $(printf "%s" "$GV_OUT" | tail -n 2 | tr '\n' ' ')"
      warn "Jobs will use Docker's ordinary runtime. Every other restriction still applies."
    fi
  fi
else
  note "skipped (--no-gvisor)"
fi

# The graphics card, still inside gVisor (phase 6). gVisor can pass an
# NVIDIA card through its own checked layer (nvproxy) for the drivers
# it knows; it is switched on as a SECOND runtime, "runsc-gpu", so the
# ordinary one is untouched. Only that runtime is ever used for jobs
# that get the card. Then a test: encode a few frames on the card from
# inside it. If that fails, screens are encoded on the CPU instead.
#
# gVisor's GPU layer supports Turing cards (2018, compute 7.5) and newer.
# Older cards are found and then fail deep inside CUDA with "unknown
# error" (seen on the Quadro K2200, compute 5.0), so they are recognised
# here and not tried: screens are encoded on the processor, which works.
GPU_RUNTIME="" ; GPU_SAID="not tried"
GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true)"
GPU_CAP="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ' || true)"
GPU_NEW=0
case "$GPU_CAP" in [0-9]*.[0-9]*)
  [ "${GPU_CAP%%.*}" -gt 7 ] || { [ "${GPU_CAP%%.*}" -eq 7 ] && [ "${GPU_CAP#*.}" -ge 5 ]; } && GPU_NEW=1 ;;
esac
if [ -n "$GPU_NAME" ] && [ "$GPU_NEW" = 0 ]; then
  GPU_SAID="not usable inside gVisor: $GPU_NAME is compute $GPU_CAP, gVisor needs 7.5 (Turing, 2018) or newer. Screens are encoded on the processor."
  note "the graphics card ($GPU_NAME) is too old for gVisor's GPU support; screens are encoded on the processor"
elif [ "$RUNTIME" = runsc ] && command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1 \
   && docker image inspect fieldkit-runner-screen:1 >/dev/null 2>&1; then
  if ! docker info --format '{{json .Runtimes}}' | grep -q '"runsc-gpu"'; then
    [ -f /etc/docker/daemon.json ] && cp -n /etc/docker/daemon.json /etc/docker/daemon.json.before-fieldkit
    python3 - <<'PY'
import json, os
p = "/etc/docker/daemon.json"
c = json.load(open(p)) if os.path.exists(p) else {}
c.setdefault("runtimes", {})["runsc-gpu"] = {
    "path": "/usr/local/bin/runsc",
    "runtimeArgs": ["--nvproxy=true", "--nvproxy-allowed-driver-capabilities=compute,utility,video,graphics"]}
json.dump(c, open(p, "w"), indent=4)
PY
    systemctl reload docker
    sleep 3
  fi
  GPU_OUT="$(docker run --rm --runtime=runsc-gpu --gpus all --network none --user 65534:65534 \
      -e NVIDIA_DRIVER_CAPABILITIES=video,utility fieldkit-runner-screen:1 \
      ffmpeg -nostdin -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 -frames:v 60 \
      -c:v h264_nvenc -preset p1 -tune ull -f null - 2>&1 && echo GPU-OK || true)"
  if printf "%s" "$GPU_OUT" | grep -q GPU-OK; then
    GPU_RUNTIME="runsc-gpu" ; GPU_SAID="video encoding on the card, inside gVisor"
    note "the graphics card works from inside gVisor: screens are encoded on it"
  else
    GPU_SAID="refused: $(printf "%s" "$GPU_OUT" | tail -n 2 | tr '\n' ' ' | cut -c1-200)"
    warn "the graphics card could not be used from inside gVisor; screens will be encoded on the CPU."
    warn "what it said: $(printf "%s" "$GPU_OUT" | tail -n 2 | tr '\n' ' ')"
  fi
fi

say "6/7  Settings, and starting it"
CONF="$ETC/runnerd.json"
if [ ! -f "$CONF" ]; then
  [ -n "$RELAY_URL" ] || { echo "   The relay's address is needed once:  sudo bash $0 --relay https://your-relay"; exit 1; }
  cat > "$CONF" <<JSON
{
  "host": "0.0.0.0",
  "port": 25580,
  "relayUrl": "$RELAY_URL",
  "storePath": "$STORE",
  "storeHostPath": "$STORE",
  "driver": "docker",
  "runtime": "$RUNTIME",
  "images": { "base": "fieldkit-runner:1", "wine": "$WINE_IMAGE" },
  "tiers": {},
  "machine": {}
}
JSON
  note "wrote $CONF"
else
  note "$CONF already exists and was left alone (edit it by hand to change settings)"
fi
if [ -n "$TUNNEL_TOKEN" ]; then
  ( umask 077 ; printf 'TUNNEL_TOKEN=%s\n' "$TUNNEL_TOKEN" > "$ETC/tunnel.env" )
  note "saved the tunnel token"
fi
[ -f "$ETC/tunnel.env" ] || : > "$ETC/tunnel.env"
# The filter on members' internet. Written once; edit it and rerun
# this script (or restart fk-egress) to change it.
if [ ! -f "$ETC/egress.env" ]; then
  cat > "$ETC/egress.env" <<'EGRESS'
# What members' programs may reach on the web (RUNNER_PLAN.md §6a).
#   adult     adult content, malware and phishing blocked (default)
#   family    the above, plus proxies, VPNs and mixed content
#   security  malware and phishing only
#   system    no filtering
FK_DNS_FILTER=adult
# Per running job: connections at once, and KB/s up and down.
FK_EGRESS_CONNS=16
FK_EGRESS_UP_KBPS=128
FK_EGRESS_DOWN_KBPS=1024
EGRESS
fi
# What this machine draws, for ADMIN -> POWER (RUNNER_PLAN.md §24). A
# small root service, because the processor's energy counter is
# root-only. It only reads, and it may write nowhere but $BASE/run,
# which runnerd sees read-only.
mkdir -p "$BASE/run"
install -m 0755 "$HERE/runnerd/fk-power.sh" /usr/local/sbin/fk-power
cat > /etc/systemd/system/fk-power.service <<UNIT
[Unit]
Description=FieldKit: what this machine draws, for RUNNER's ADMIN screen
After=multi-user.target

[Service]
ExecStart=/usr/local/sbin/fk-power
Environment=FK_POWER_OUT=$BASE/run/power.json
Restart=always
RestartSec=30
Nice=10
ProtectSystem=strict
ReadWritePaths=$BASE/run
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable fk-power >/dev/null 2>&1 || true
if systemctl restart fk-power; then note "power readings: the fk-power service (ADMIN -> POWER)"
else warn "fk-power did not start, so ADMIN will show no power readings:  sudo journalctl -u fk-power"; fi

# Asleep when nobody needs it (RUNNER_PLAN.md §24). Also root: suspending
# and arming the network card's Wake-on-LAN both need it. It does
# nothing until an admin switches sleeping on in ADMIN -> POWER, and
# never while anyone is logged in here.
command -v ethtool >/dev/null 2>&1 || apt-get install -y -qq ethtool >/dev/null 2>&1 || true
install -m 0755 "$HERE/runnerd/fk-sleep.sh" /usr/local/sbin/fk-sleep
cat > /etc/systemd/system/fk-sleep.service <<UNIT
[Unit]
Description=FieldKit: sleep when RUNNER has nothing to do, wake by Wake-on-LAN
After=multi-user.target docker.service

[Service]
ExecStart=/usr/local/sbin/fk-sleep
Environment=FK_SLEEP_PLAN=$STORE/sleep-plan.json
Environment=FK_SLEEP_OUT=$BASE/run/wake.json
Restart=always
RestartSec=30
Nice=10
ProtectSystem=strict
ReadWritePaths=$BASE/run
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable fk-sleep >/dev/null 2>&1 || true
if systemctl restart fk-sleep; then
  sleep 2; WOLS=$(cat "$BASE/run/wake.json" 2>/dev/null || true)
  case "$WOLS" in
    *'"supports":"'*g*) note "sleeping: fk-sleep is ready; the network card can be woken (switch Wake-on-LAN on in the BIOS, then in ADMIN -> POWER)" ;;
    *) note "sleeping: fk-sleep is running, but the network card does not offer Wake-on-LAN, so ADMIN will not let it sleep" ;;
  esac
else warn "fk-sleep did not start, so this machine will never sleep:  sudo journalctl -u fk-sleep"; fi

PROFILE="" ; grep -q '^TUNNEL_TOKEN=.' "$ETC/tunnel.env" && PROFILE="--profile tunnel"
# shellcheck disable=SC2086
( cd "$APP" && FK_STORE="$STORE" FK_ETC="$ETC" FK_RUN="$BASE/run" docker compose --env-file "$ETC/tunnel.env" \
    -f runnerd/compose.yml --project-directory "$APP" $PROFILE up -d --build --remove-orphans >/dev/null 2>&1 ) \
  || { echo "   docker compose failed. See:  cd $APP && sudo docker compose -f runnerd/compose.yml logs"; exit 1; }
note "started"

# Keep the two things this script decides (gVisor, the Windows image)
# in step with what it just found, without touching anything else in
# a settings file that may have been edited by hand.
if command -v python3 >/dev/null; then
  python3 - "$CONF" "$RUNTIME" "$WINE_IMAGE" "$GVISOR" "$WINE" "$GPU_RUNTIME" <<'PY'
import json, sys
path, runtime, wine, want_gvisor, want_wine, gpu = sys.argv[1:7]
with open(path) as f: c = json.load(f)
before = json.dumps(c, sort_keys=True)
if want_gvisor == "1" or runtime: c["runtime"] = runtime
if want_wine == "1": c.setdefault("images", {})["wine"] = wine
c.setdefault("gpu", {})["runtime"] = gpu
if json.dumps(c, sort_keys=True) != before:
    with open(path, "w") as f: json.dump(c, f, indent=2)
    print("   settings updated to match (runtime=%r, wine=%r)" % (c.get("runtime"), c.get("images", {}).get("wine")))
PY
  docker restart fieldkit-runner-runnerd-1 >/dev/null 2>&1 || true
fi

say "7/7  Checking it"
OK=0
for _ in $(seq 1 20); do
  H="$(curl -fsS -m 3 http://127.0.0.1:25580/health 2>/dev/null || true)"
  case "$H" in *'"service":"fieldkit-runnerd"'*) OK=1; break ;; esac
  sleep 1
done
if [ "$OK" = 1 ]; then
  note "the run server answers on this machine"
  case "$H" in
    *'"ready":true'*) note "and it has the relay's key: ready" ;;
    *) warn "it is up but not ready yet: it could not get the relay's key."
       warn "That is expected until the relay has been updated and has runner.enabled set. It retries every minute." ;;
  esac
else
  warn "the run server did not answer. See:  sudo docker logs fieldkit-runner-runnerd-1"
fi

UP="$( { curl -s -m 25 -o /dev/null -w '%{speed_upload}' -X POST --data-binary @<(head -c 20000000 /dev/zero) \
        https://speed.cloudflare.com/__up 2>/dev/null || echo 0; } | cut -d. -f1)"
UP_MBPS=$(( ${UP:-0} * 8 / 1000000 ))

echo
echo "================ PASTE THIS BACK ================"
echo "run server:   $([ "$OK" = 1 ] && echo up || echo NOT ANSWERING)"
echo "health:       ${H:-none}"
echo "sandbox:      docker $(docker version --format '{{.Server.Version}}'), runtime ${RUNTIME:-default (no gVisor)}"
echo "windows exe:  ${WINE_IMAGE:-off}"
echo "screens:      $(docker image inspect fieldkit-runner-screen:1 >/dev/null 2>&1 && echo on || echo off)"
echo "gpu:          $GPU_SAID"
echo "power:        $(cat "$BASE/run/power.json" 2>/dev/null || echo "no reading yet")"
echo "sleep:        $(cat "$BASE/run/wake.json" 2>/dev/null || echo "fk-sleep has not written yet")"
echo "disk:         $(df -h --output=size,avail,target "$BASE" | tail -1 | xargs)"
echo "upload speed: ${UP_MBPS} Mbit/s (measured to Cloudflare just now)"
echo "tunnel:       $([ -n "$PROFILE" ] && echo "running" || echo "NOT SET UP YET")"
echo "kernel:       $(uname -r)"
echo "================================================="
if [ -z "$PROFILE" ]; then
  echo
  echo "One thing left: the tunnel, which gives this machine its public name."
  echo "When you have the token from Cloudflare, run:"
  echo "   sudo bash $0 --tunnel-token PASTE-THE-TOKEN-HERE"
fi
