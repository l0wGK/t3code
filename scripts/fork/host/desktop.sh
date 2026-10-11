#!/bin/bash
# The agent desktops (see ~/desktop-service.sh). Each runs as its own systemd
# unit, so restarting the T3 Code server doesn't stop them.
#
#   ~/desktop.sh claim "<task>"   Reserve a free desktop for this task; prints its number N.
#   ~/desktop.sh release N        Give desktop N back when the task is done.
#   ~/desktop.sh open N <url>     Open a URL in desktop N's Firefox (and keep the claim fresh).
#   ~/desktop.sh status           Show which desktops are claimed, by what, and since when.
#   ~/desktop.sh [url]            Old form: open a URL on desktop 1.
#
# Run GUI commands for desktop N with DISPLAY=:N. A claim not used (claim/open)
# for three hours is considered abandoned and can be claimed again.
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

open_url() {
  local profile=()
  [ "$1" -ne 1 ] && profile=(--profile "$HOME/.config/mozilla/firefox/desktop-$1")
  ensure "$1"
  DISPLAY=":$1" setsid firefox "${profile[@]}" --new-tab "$2" >/dev/null 2>&1 </dev/null &
}

case "${1:-}" in
  claim)
    label="${2:-unnamed task}"
    find "$CLAIMS" -type f -mmin +"$STALE_MINUTES" -delete
    for d in "${DESKTOPS[@]}"; do
      if (set -o noclobber; printf '%s\n' "$label" >"$CLAIMS/$d") 2>/dev/null; then
        ensure "$d"
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
    sed -n '2,15p' "$0"
    ;;
  *)
    ensure 1
    [ -n "${1:-}" ] && open_url 1 "$1"
    ;;
esac
