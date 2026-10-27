#!/usr/bin/env bash
# FieldKit RUNNER :: inspect.sh (RUNNER_PLAN.md, phase 1a)
#
# READ-ONLY. This script changes nothing on the machine: it installs
# nothing, writes no files, starts no services and edits no settings.
# It only prints what is already there, so the setup script that comes
# next can be written for THIS machine instead of for a guess.
#
# Run it on Bastion 2 and paste the whole output back:
#
#     bash inspect.sh
#
# It does not need sudo. A few lines say "needs sudo to read" when run
# without it; that is fine, and those are noted rather than guessed.
#
# WHAT IS DELIBERATELY NOT PRINTED: public IP addresses, MAC addresses,
# Wi-Fi names, user password hashes, SSH keys, the Tailscale auth key or
# the tunnel token. Private (LAN/tailnet) addresses are printed because
# the setup needs them and they mean nothing outside your network.

set -u
export LC_ALL=C

have() { command -v "$1" >/dev/null 2>&1; }
hr()   { printf '\n=== %s ===\n' "$1"; }
try()  { "$@" 2>/dev/null || echo "(not available: $1)"; }

echo "FieldKit RUNNER inspection — $(date -u +%Y-%m-%dT%H:%MZ)"
echo "read-only; nothing on this machine was changed"

hr "SYSTEM"
if [ -r /etc/os-release ]; then
  . /etc/os-release
  echo "os:        ${PRETTY_NAME:-unknown}"
fi
echo "kernel:    $(uname -r)"
echo "arch:      $(uname -m)"
echo "uptime:    $(uptime -p 2>/dev/null || uptime)"
echo "user:      $(id -un) (uid $(id -u)); sudo group: $(id -nG | grep -qw sudo && echo yes || echo no)"
echo "virt:      $(try systemd-detect-virt)"
echo "secureboot: $(have mokutil && mokutil --sb-state 2>/dev/null || echo unknown)"

hr "CPU"
if have lscpu; then
  lscpu | grep -E '^(Model name|Socket|Core|Thread|CPU\(s\)|CPU max MHz|Flags)' \
        | sed -E 's/^Flags:.*/Flags: (see next line)/'
  echo "virt flags: $(grep -m1 -oE 'vmx|svm' /proc/cpuinfo | head -1 || true)"
  echo "avx:        $(grep -m1 -oE 'avx2|avx' /proc/cpuinfo | sort -u | tr '\n' ' ')"
fi
echo "load:      $(cut -d' ' -f1-3 /proc/loadavg)"

hr "MEMORY"
try free -h
echo "swappiness: $(cat /proc/sys/vm/swappiness 2>/dev/null)"
echo "zram/zswap: $(ls /sys/block 2>/dev/null | grep -c zram) zram device(s); zswap enabled=$(cat /sys/module/zswap/parameters/enabled 2>/dev/null || echo n/a)"
echo "ksm:        run=$(cat /sys/kernel/mm/ksm/run 2>/dev/null || echo n/a)"

hr "DISKS"
try lsblk -o NAME,SIZE,TYPE,ROTA,FSTYPE,MOUNTPOINT
echo
try df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay
echo
echo "inodes on /:"; df -i / 2>/dev/null | tail -1
echo "lvm:       $(have vgs && (vgs --noheadings -o vg_name,vg_size,vg_free 2>/dev/null || echo 'needs sudo to read') || echo none)"
echo "(ROTA 1 = spinning disk, 0 = SSD. It decides how the store is laid out.)"

hr "GPU"
if have lspci; then lspci -nn | grep -iE 'vga|3d|display' || echo "no GPU seen by lspci"; else echo "(lspci not installed)"; fi
if have nvidia-smi; then
  nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,temperature.gpu \
             --format=csv 2>/dev/null || echo "nvidia-smi is installed but failed (driver not loaded?)"
  echo "encoder sessions: $(nvidia-smi --query-gpu=encoder.stats.sessionCount --format=csv,noheader 2>/dev/null || echo n/a)"
else
  echo "nvidia-smi: NOT INSTALLED (no NVIDIA driver yet)"
fi
echo "kernel modules: $(lsmod 2>/dev/null | grep -oE '^(nvidia[a-z_]*|nouveau)' | sort -u | tr '\n' ' ')"
echo "driver packages: $(dpkg -l 2>/dev/null | awk '/^ii +nvidia-driver|^ii +nvidia-headless|^ii +libnvidia-encode/ {print $2}' | tr '\n' ' ')"
echo "render nodes: $(ls /dev/dri 2>/dev/null | tr '\n' ' ')"
echo "container toolkit: $(have nvidia-ctk && nvidia-ctk --version 2>/dev/null | head -1 || echo 'not installed')"

hr "SANDBOX PREREQUISITES"
echo "cgroup:    $(stat -fc %T /sys/fs/cgroup 2>/dev/null) (cgroup2fs is what is wanted)"
echo "controllers: $(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null)"
echo "delegated to this user: $(cat "/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers" 2>/dev/null || echo unknown)"
echo "user namespaces: max=$(cat /proc/sys/user/max_user_namespaces 2>/dev/null) unprivileged_clone=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo n/a) apparmor_restrict=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo n/a)"
echo "subuid:    $(grep -c "^$(id -un):" /etc/subuid 2>/dev/null) range(s) for $(id -un)"
echo "kvm:       $([ -e /dev/kvm ] && echo present || echo absent)"
echo "apparmor:  $(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || echo n/a)"
echo "seccomp:   $(grep -c Seccomp /proc/self/status 2>/dev/null) (1 = supported)"
echo "linger:    $(loginctl show-user "$(id -un)" -p Linger 2>/dev/null || echo unknown)"
for t in podman docker runsc crun runc newuidmap slirp4netns pasta fuse-overlayfs bwrap; do
  if have "$t"; then echo "$t: $("$t" --version 2>/dev/null | head -1)"; else echo "$t: not installed"; fi
done
if have docker; then
  echo "docker containers running: $(docker ps -q 2>/dev/null | wc -l) (0 may just mean this user cannot ask)"
fi
echo "pterodactyl wings: $(systemctl is-active wings 2>/dev/null || echo 'not present')"

hr "SOFTWARE"
for t in node npm python3 sqlite3 ffmpeg wine wine64 Xvfb Xorg gamescope sway weston pipewire pulseaudio git curl zstd; do
  if have "$t"; then echo "$t: $("$t" --version 2>&1 | head -1 | cut -c1-70)"; else echo "$t: not installed"; fi
done
if have ffmpeg; then
  echo "ffmpeg hardware encoders: $(ffmpeg -hide_banner -encoders 2>/dev/null | grep -oE '(h264|hevc|av1)_(nvenc|vaapi|qsv)' | sort -u | tr '\n' ' ')"
fi
echo "systemd:   $(systemctl --version 2>/dev/null | head -1)"
echo "32-bit libs enabled: $(dpkg --print-foreign-architectures 2>/dev/null | tr '\n' ' ')"

hr "NETWORK"
# Private addresses only. Anything public is counted, not shown.
if have ip; then
  ip -o -4 addr show 2>/dev/null | awk '{print $2, $4}' | while read -r ifc a; do
    case "$a" in
      10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*|127.*|169.254.*)
        echo "$ifc $a" ;;
      *) echo "$ifc (public address, not shown)" ;;
    esac
  done
  echo "ipv6:      $(ip -o -6 addr show scope global 2>/dev/null | wc -l) global address(es), not shown"
  echo "default route via interface: $(ip route show default 2>/dev/null | awk '{print $5; exit}')"
fi
echo "resolver:  $(grep -E '^nameserver' /etc/resolv.conf 2>/dev/null | tr '\n' ' ')"
if have resolvectl; then resolvectl dns 2>/dev/null | grep -v ': *$' | head -6; fi
echo "listening tcp ports:"
if have ss; then ss -H -tln 2>/dev/null | awk '{print "  " $4}' | sort -u; fi
echo "firewall:  ufw=$(have ufw && (ufw status 2>/dev/null | head -1 || echo 'needs sudo to read') || echo 'not installed'); nft=$(have nft && echo installed || echo 'not installed')"
echo "tailscale: $(have tailscale && (tailscale status --peers=false 2>/dev/null | head -1 | awk '{print $1, $2, $NF}' || echo 'installed, not running') || echo 'not installed')"
echo "cloudflared: $(have cloudflared && cloudflared --version 2>/dev/null | head -1 || echo 'not installed'); service=$(systemctl is-active cloudflared 2>/dev/null || echo none)"
echo "can reach cloudflare: $(have curl && curl -s -o /dev/null -m 6 -w '%{http_code}' https://www.cloudflare.com/cdn-cgi/trace || echo 'curl missing')"

hr "HOUSEKEEPING"
echo "time sync: $(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)"
echo "timezone:  $(timedatectl show -p Timezone --value 2>/dev/null || echo unknown)"
echo "auto updates: $(systemctl is-enabled unattended-upgrades 2>/dev/null || echo 'not present')"
echo "reboot needed: $([ -f /var/run/reboot-required ] && echo yes || echo no)"
echo "open file limit: $(ulimit -n)   max processes: $(ulimit -u)"
echo "failed units: $(systemctl --failed --no-legend 2>/dev/null | wc -l)"
echo "biggest things under /home and /var (top 5 each, may be partial without sudo):"
du -xsh /home/* /var/lib/* 2>/dev/null | sort -rh | head -10 | sed 's/^/  /'

hr "END"
echo "Paste everything above back. Nothing was changed."
