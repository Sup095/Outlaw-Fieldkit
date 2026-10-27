#!/bin/bash
# FieldKit fk-sleep: puts Bastion 2 to sleep when RUNNER has nothing to
# do, so it draws ~3 W instead of 60-90 W (RUNNER_PLAN.md §24).
# Installed and started by setup.sh as the fk-sleep service; runs as
# root because suspending the machine and arming the network card's
# Wake-on-LAN both need root.
#
# It decides nothing by itself. Every 15 seconds:
#   reads   the plan runnerd writes, $FK_SLEEP_PLAN; "sleep":true is
#           runnerd saying nothing is running, nobody is waiting, and
#           nobody has done anything for the idle time an admin set
#   writes  what it sees, $FK_SLEEP_OUT, which runnerd reads through a
#           read-only mount and shows in ADMIN:
#             iface/mac   the card on the default route, and its address
#             supports    what it can be woken by ("g" = magic packet)
#             wol         what it is set to now ("d" = off)
#             blocked     why it will not sleep even if asked
#             resumedAt   when it last woke up
#
# And it refuses to sleep, whatever the plan says, while:
#   - somebody is logged in (a terminal, a desktop or an SSH session)
#   - it booted or woke up less than 10 minutes ago
#   - the plan is more than 40 seconds old (runnerd has stopped)
#   - the card cannot be woken by a magic packet

PLAN="${FK_SLEEP_PLAN:-/srv/fieldkit/store/sleep-plan.json}"
OUT="${FK_SLEEP_OUT:-/srv/fieldkit/run/wake.json}"
EVERY="${FK_SLEEP_EVERY:-15}"
GRACE="${FK_SLEEP_GRACE:-600}"
NET="${FK_SLEEP_NET:-/sys/class/net}"

mkdir -p "$(dirname "$OUT")"
last=$(date +%s)
resumed=""
booted=$(( last - $(cut -d. -f1 /proc/uptime) ))

while :; do
  now=$(date +%s)
  # A jump in the clock this big is the machine having been asleep.
  if [ $(( now - last )) -gt $(( EVERY * 4 )) ]; then
    resumed=$now
    echo "fk-sleep: awake again after $(( now - last )) s"
  fi
  last=$now

  iface=$(ip route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
  mac="" ; supports="" ; wol=""
  if [ -n "$iface" ] && [ -r "$NET/$iface/address" ]; then
    mac=$(cat "$NET/$iface/address")
    info=$(ethtool "$iface" 2>/dev/null || true)
    supports=$(printf '%s\n' "$info" | awk -F': *' '/Supports Wake-on/ { print $2; exit }')
    wol=$(printf '%s\n' "$info" | awk -F': *' '/^[[:space:]]*Wake-on/ { print $2; exit }')
  fi

  blocked=""
  if [ -n "$(who 2>/dev/null)" ] || pgrep -f '^sshd(-session)?: [^ ]+@' >/dev/null 2>&1; then
    blocked="someone is logged in on Bastion 2"
  elif [ $(( now - booted )) -lt $GRACE ]; then
    blocked="it started less than 10 minutes ago"
  elif [ -n "$resumed" ] && [ $(( now - resumed )) -lt $GRACE ]; then
    blocked="it woke up less than 10 minutes ago"
  fi

  plan=$(cat "$PLAN" 2>/dev/null || true)
  pat=$(printf '%s' "$plan" | grep -o '"at":[0-9]*' | head -1 | cut -d: -f2)
  fresh=0
  [ -n "$pat" ] && [ $(( now - pat )) -le 40 ] && fresh=1
  can=0
  case "$supports" in *g*) can=1 ;; esac

  # Armed as soon as runnerd says it is about to sleep, so ADMIN shows
  # it; the setting does not survive a reboot, so it is set every time.
  if [ "$fresh" = 1 ] && [ "$can" = 1 ] && printf '%s' "$plan" | grep -q '"soon":true' && [ "$wol" != "g" ]; then
    ethtool -s "$iface" wol g 2>/dev/null && wol=g
  fi

  printf '{"at":%s,"iface":"%s","mac":"%s","supports":"%s","wol":"%s","blocked":%s,"resumedAt":%s}\n' \
    "$now" "$iface" "$mac" "$supports" "$wol" \
    "$( [ -n "$blocked" ] && printf '"%s"' "$blocked" || printf null )" "${resumed:-null}" > "$OUT.tmp" && mv -f "$OUT.tmp" "$OUT"

  if [ "$fresh" = 1 ] && [ "$can" = 1 ] && [ -z "$blocked" ] && printf '%s' "$plan" | grep -q '"sleep":true'; then
    ethtool -s "$iface" wol g 2>/dev/null || true
    echo "fk-sleep: RUNNER has nothing to do; going to sleep (wake-on-LAN armed on $iface, $mac)"
    sync
    systemctl suspend || echo "fk-sleep: suspend failed"
    # Do not ask again until well after waking, whatever happened.
    sleep $(( EVERY * 4 ))
    last=$(date +%s)
    resumed=$last
  fi
  sleep "$EVERY"
done
