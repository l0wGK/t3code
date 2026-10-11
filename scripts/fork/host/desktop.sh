#!/bin/bash
# Make sure the virtual desktop is up, then open a URL in Firefox on it.
# The desktop itself runs as t3-desktop.service (see ~/desktop-service.sh), so
# restarting the T3 Code server no longer kills it.
#   ~/desktop.sh [url]
# Viewer: http://<host>:6080/vnc.html on the LAN, https://<tailnet host>:8443/vnc.html
# over Tailscale, or the T3 Desktop panel.
export DISPLAY=:1
systemctl --user is-active --quiet t3-desktop.service || systemctl --user start t3-desktop.service
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
if [ -n "${1:-}" ]; then
  setsid firefox --new-tab "$1" >/dev/null 2>&1 < /dev/null &
fi
