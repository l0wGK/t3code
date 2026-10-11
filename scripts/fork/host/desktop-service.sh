#!/bin/bash
# Runs one virtual GUI desktop for agents and the Desktop panel as one unit,
# independent of the T3 Code server's lifecycle:
#   desktop-service.sh [N]   (default 1)
# Desktop N is display :N (TigerVNC Xvnc), VNC on localhost:590N (password
# ~/.vnc/passwd), noVNC on port 6079+N. Desktop 1 runs as t3-desktop.service and
# uses Firefox's default profile; desktop 2 and up run as t3-desktop@N.service,
# each with its own Firefox profile, so agents on different desktops never share
# a mouse, a keyboard focus, or a browser session.
# Each part is supervised: if it exits (Firefox can be closed from the viewer),
# it is restarted so the viewer can reconnect.
set -u
n="${1:-1}"
[[ "$n" =~ ^[1-9]$ ]] || { echo "usage: $0 [1-9]" >&2; exit 2; }
export DISPLAY=":$n"
log=/tmp/t3-desktop-$n

supervise() {
  local name="$1" delay="$2"
  shift 2
  while true; do
    "$@"
    echo "$name exited with status $?; restarting in ${delay}s" >&2
    sleep "$delay"
  done
}

firefox_args=()
if [ "$n" -ne 1 ]; then
  profile="$HOME/.config/mozilla/firefox/desktop-$n"
  if [ ! -d "$profile" ]; then
    mkdir -p "$profile"
    cat >"$profile/user.js" <<'EOF'
// Created by desktop-service.sh for a T3 agent desktop.
// Use the system resolver (no DNS over HTTPS) and IPv4 only.
user_pref("network.dns.disableIPv6", true);
user_pref("network.trr.mode", 5);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("browser.startup.homepage_override.mstone", "ignore");
// Tabs in the title bar with Firefox's own window controls (no WM title bar).
user_pref("browser.tabs.inTitlebar", 1);
// The service restarts Firefox; open a normal window instead of the crash-restore page.
user_pref("browser.sessionstore.resume_from_crash", false);
EOF
  fi
  firefox_args=(--profile "$profile")
fi

rm -f "/tmp/.X$n-lock" "/tmp/.X11-unix/X$n"
# TigerVNC's Xvnc is both the X server and the VNC server. Unlike x11vnc it
# syncs the clipboard as UTF-8 (noVNC's extended clipboard), and only the real
# clipboard is sent to viewers, not every text selection.
Xvnc ":$n" -geometry 1280x800 -depth 24 -rfbport $((5900 + n)) -localhost yes \
  -SecurityTypes VncAuth -PasswordFile "$HOME/.vnc/passwd" -AlwaysShared \
  -SendPrimary=0 >>"$log-xvnc.log" 2>&1 &
xserver=$!
for _ in $(seq 1 50); do [ -e "/tmp/.X11-unix/X$n" ] && break; sleep 0.1; done

supervise fluxbox 1 fluxbox >>"$log-fluxbox.log" 2>&1 &
# Taskbar (tint2, ~/.config/tint2/tint2rc): window list, Firefox launcher, clock.
# The wallpaper comes from fluxbox's rootCommand (~/.fluxbox/init).
supervise tint2 2 tint2 >>"$log-tint2.log" 2>&1 &
# Desktop 1's noVNC also listens on the LAN (Tailscale serves it too); the
# others are only reached through the T3 Desktop panel.
listen=127.0.0.1
[ "$n" -eq 1 ] && listen=0.0.0.0
supervise websockify 1 websockify --web /usr/share/novnc "$listen:$((6079 + n))" \
  "127.0.0.1:$((5900 + n))" >>"$log-websockify.log" 2>&1 &
# Agents and the panel expect a browser on the desktop; bring it back if closed.
supervise firefox 3 firefox "${firefox_args[@]}" >>"$log-firefox.log" 2>&1 &

# The desktop lives as long as the X server; the service restarts it if it dies.
wait "$xserver"
