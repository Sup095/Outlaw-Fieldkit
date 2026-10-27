#!/bin/bash
# Runs a Windows program inside a job.
#
# Wine needs a "prefix": a fake C: drive plus a registry, and it has to
# be able to write to it. The one prepared in the image is 770 MB and
# read-only, and a job's scratch space is memory, so copying it would
# cost every job most of a gigabyte of RAM.
#
# So the job gets a prefix that is almost entirely LINKS: the big
# read-only Windows folder is pointed at where it already is, and only
# the parts a program actually writes (the registry, the user folder)
# are copied. That is about 2 MB and takes a few milliseconds.
P=/opt/wineprefix
W=/work/.wine
if [ ! -d "$W" ]; then
  mkdir -p "$W/dosdevices" "$W/drive_c"
  cp -a "$P"/*.reg "$W"/ 2>/dev/null
  cp -a "$P/.update-timestamp" "$W"/ 2>/dev/null
  ln -s ../drive_c "$W/dosdevices/c:"
  ln -s / "$W/dosdevices/z:"
  for d in "$P"/drive_c/*; do
    n="$(basename "$d")"
    case "$n" in
      users|ProgramData) cp -a "$d" "$W/drive_c/" ;;
      *) ln -s "$d" "$W/drive_c/$n" ;;
    esac
  done
fi
# Debian's Wine crashes at start ("free(): invalid pointer") when TMPDIR is
# set, which runnerd sets for every job. Found by adding the sandbox
# flags one at a time.
unset TMPDIR
export WINEDEBUG=-all WINEARCH=win64 WINEPREFIX="$W" XDG_RUNTIME_DIR=/tmp
exec wine "$@"
