#!/bin/bash
# The agent desktops (see ~/desktop-service.sh). Each runs as its own systemd
# unit, so restarting the T3 Code server doesn't stop them.
#
#   ~/desktop.sh claim "<task>"   Reserve a free desktop for this task; prints its number N.
#   ~/desktop.sh release N        Give desktop N back when the task is done.
#   ~/desktop.sh open N <url>     Open a URL in desktop N's Firefox (and keep the claim fresh).
#   ~/desktop.sh doc N <file>     Open a document in LibreOffice on desktop N (and keep the claim fresh).
#   ~/desktop.sh status           Show which desktops are claimed, by what, and since when.
#   ~/desktop.sh refresh N        Restart desktop N's Firefox with desktop 1's current sign-ins.
#   ~/desktop.sh [url]            Old form: open a URL on desktop 1.
#
# Desktop 1 holds the sign-ins: desktops 2 and up get a copy of its cookies
# whenever they're claimed. Run GUI commands for desktop N with DISPLAY=:N.
# A claim not used (claim/open) for three hours is considered abandoned and can
# be claimed again.
# Viewer: the T3 Desktop panel (switch desktops with 1/2/3), or desktop 1 at
# http://<host>:6080/vnc.html on the LAN.
set -u
DESKTOPS=(${T3_DESKTOPS:-1 2 3})
CLAIMS=/tmp/t3-desktop-claims
STALE_MINUTES=180
mkdir -p "$CLAIMS"

unit() { [ "$1" -eq 1 ] && echo t3-desktop.service || echo "t3-desktop@$1.service"; }

ensure() {
  systemctl --user is-active --quiet "$(unit "$1")" || systemctl --user start "$(unit "$1")"
  for _ in $(seq 1 50); do [ -e "/tmp/.X11-unix/X$1" ] && break; sleep 0.1; done
}

valid() {
  local d
  for d in "${DESKTOPS[@]}"; do [ "$d" = "${1:-}" ] && return 0; done
  echo "No desktop '${1:-}'. Desktops: ${DESKTOPS[*]}" >&2
  exit 2
}

# Restarts Firefox on desktop N (2 and up); the service copies desktop 1's
# sign-ins before starting it again. Only Firefox in that desktop's unit is touched.
refresh() {
  local cgroup pid old=""
  [ "$1" -ne 1 ] || return 0
  ensure "$1"
  cgroup="/sys/fs/cgroup$(systemctl --user show -p ControlGroup --value "$(unit "$1")")"
  for pid in $(cat "$cgroup/cgroup.procs" 2>/dev/null); do
    [ "$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | cut -d' ' -f1)" = firefox ] && old="$pid"
  done
  [ -n "$old" ] && kill "$old"
  for _ in $(seq 1 100); do
    sleep 0.2
    [ -n "$old" ] && [ -e "/proc/$old" ] && continue
    DISPLAY=":$1" wmctrl -l 2>/dev/null | grep -q 'Mozilla Firefox' && return 0
  done
  echo "Firefox on desktop $1 didn't come back within 20 seconds" >&2
}

open_url() {
  local profile=()
  [ "$1" -ne 1 ] && profile=(--profile "$HOME/.config/mozilla/firefox/desktop-$1")
  ensure "$1"
  DISPLAY=":$1" setsid firefox "${profile[@]}" --new-tab "$2" >/dev/null 2>&1 </dev/null &
}

# LibreOffice runs one instance per profile and hands later files to it, so each
# desktop gets its own profile or documents would open on another desktop.
open_doc() {
  ensure "$1"
  DISPLAY=":$1" setsid soffice -env:UserInstallation="file://$HOME/.config/libreoffice-desktop-$1" \
    "$2" >/dev/null 2>&1 </dev/null &
}

case "${1:-}" in
  claim)
    label="${2:-unnamed task}"
    find "$CLAIMS" -type f -mmin +"$STALE_MINUTES" -delete
    for d in "${DESKTOPS[@]}"; do
      if (set -o noclobber; printf '%s\n' "$label" >"$CLAIMS/$d") 2>/dev/null; then
        ensure "$d"
        refresh "$d"
        echo "$d"
        exit 0
      fi
    done
    echo "All desktops are in use:" >&2
    "$0" status >&2
    exit 1
    ;;
  release)
    valid "${2:-}"
    rm -f "$CLAIMS/$2"
    ;;
  open)
    valid "${2:-}"
    [ -n "${3:-}" ] || { echo "usage: $0 open N <url>" >&2; exit 2; }
    [ -e "$CLAIMS/$2" ] && touch "$CLAIMS/$2"
    open_url "$2" "$3"
    ;;
  doc)
    valid "${2:-}"
    [ -f "${3:-}" ] || { echo "usage: $0 doc N <file>" >&2; exit 2; }
    [ -e "$CLAIMS/$2" ] && touch "$CLAIMS/$2"
    open_doc "$2" "$(realpath "$3")"
    ;;
  refresh)
    valid "${2:-}"
    refresh "$2"
    ;;
  status)
    for d in "${DESKTOPS[@]}"; do
      if [ -e "$CLAIMS/$d" ]; then
        echo "desktop $d: claimed by \"$(cat "$CLAIMS/$d")\", last used $(date -r "$CLAIMS/$d" '+%H:%M')"
      else
        echo "desktop $d: free"
      fi
    done
    ;;
  -h | --help)
    sed -n '2,18p' "$0"
    ;;
  *)
    ensure 1
    [ -n "${1:-}" ] && open_url 1 "$1"
    ;;
esac
