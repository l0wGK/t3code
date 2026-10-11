#!/bin/bash
# Runs the virtual GUI desktop for agents and the Desktop panel as one unit
# (t3-desktop.service), independent of the T3 Code server's lifecycle.
# Display :1 (TigerVNC Xvnc), VNC on localhost:5901 (password ~/.vnc/passwd), noVNC on :6080.
# Each part is supervised: if it exits (Firefox can be closed from the viewer),
# it is restarted so the viewer can reconnect.
export DISPLAY=:1

supervise() {
  local name="$1" delay="$2"
  shift 2
  while true; do
    "$@"
    echo "$name exited with status $?; restarting in ${delay}s" >&2
    sleep "$delay"
  done
}

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
# TigerVNC's Xvnc is both the X server and the VNC server. Unlike x11vnc it
# syncs the clipboard as UTF-8 (noVNC's extended clipboard), and only the real
# clipboard is sent to viewers, not every text selection.
Xvnc :1 -geometry 1280x800 -depth 24 -rfbport 5901 -localhost yes \
  -SecurityTypes VncAuth -PasswordFile "$HOME/.vnc/passwd" -AlwaysShared \
  -SendPrimary=0 >>/tmp/xvnc.log 2>&1 &
xserver=$!
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done

supervise fluxbox 1 fluxbox >>/tmp/fluxbox.log 2>&1 &
# Taskbar (tint2, ~/.config/tint2/tint2rc): window list, Firefox launcher, clock.
# The wallpaper comes from fluxbox's rootCommand (~/.fluxbox/init).
supervise tint2 2 tint2 >>/tmp/tint2.log 2>&1 &
supervise websockify 1 websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5901 \
  >>/tmp/websockify.log 2>&1 &
# Agents and the panel expect a browser on the desktop; bring it back if closed.
supervise firefox 3 firefox >>/tmp/firefox.log 2>&1 &

# The desktop lives as long as the X server; the service restarts it if it dies.
wait "$xserver"
