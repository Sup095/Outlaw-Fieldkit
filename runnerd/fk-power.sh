#!/bin/bash
# FieldKit fk-power: what Bastion 2 draws, for RUNNER's ADMIN screen
# (RUNNER_PLAN.md §24). Installed and started by setup.sh as the
# fk-power service; runs as root because the processor's energy
# counter can only be read by root.
#
# Once a minute it writes one small file, /srv/fieldkit/run/power.json,
# which runnerd reads through a read-only mount:
#   at        when, in seconds
#   cpuW      the CPU package's average watts over the last minute (RAPL)
#   gpuW      the graphics card's watts, as nvidia-smi reports them
#   gpuState  the card's power state (P0 busy ... P8 idle)
#   gpuTempC  the card's temperature
# Anything it cannot read is null. It reads; it never changes a setting.

OUT="${FK_POWER_OUT:-/srv/fieldkit/run/power.json}"
RAPL="${FK_POWER_RAPL:-/sys/class/powercap/intel-rapl:0}"
EVERY="${FK_POWER_EVERY:-60}"

isnum() { [[ "$1" =~ ^[0-9]+(\.[0-9]+)?$ ]]; }

mkdir -p "$(dirname "$OUT")"
prev="" ; prevt=""
while :; do
  now=$(date +%s%N)
  cpu=null
  e=$(cat "$RAPL/energy_uj" 2>/dev/null || true)
  if isnum "$e"; then
    if [ -n "$prev" ]; then
      d=$(( e - prev ))
      # The counter wraps; its range is in the next file along.
      if [ "$d" -lt 0 ]; then
        max=$(cat "$RAPL/max_energy_range_uj" 2>/dev/null || echo 0)
        d=$(( d + max ))
      fi
      dt=$(( (now - prevt) / 1000 ))      # microseconds, so uJ/us = W
      [ "$dt" -gt 0 ] && [ "$d" -ge 0 ] && cpu=$(awk -v d="$d" -v t="$dt" 'BEGIN { w = d / t; if (w < 2000) printf "%.1f", w; else printf "null" }')
    fi
    prev=$e ; prevt=$now
  fi

  gpu=null ; state="" ; temp=null
  if command -v nvidia-smi >/dev/null 2>&1; then
    IFS=', ' read -r gw ps gt < <(nvidia-smi --query-gpu=power.draw,pstate,temperature.gpu \
      --format=csv,noheader,nounits 2>/dev/null | head -1) || true
    isnum "${gw:-}" && gpu=$gw
    [[ "${ps:-}" =~ ^P[0-9]{1,2}$ ]] && state=$ps
    isnum "${gt:-}" && temp=$gt
  fi

  printf '{"at":%s,"cpuW":%s,"gpuW":%s,"gpuState":"%s","gpuTempC":%s}\n' \
    "$(( now / 1000000000 ))" "$cpu" "$gpu" "$state" "$temp" > "$OUT.tmp" && mv -f "$OUT.tmp" "$OUT"
  sleep "$EVERY"
done
