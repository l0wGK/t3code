#!/bin/bash
# Fork addition: install a built T3 Code .app into /Applications, backing up
# the app it replaces. Used by build-mac-app.sh with T3_FORK_SKIP_INSTALL=1.
#   install-mac-app.sh "/path/to/T3 Code (Alpha).app"
set -euo pipefail
APP="${1:?path to the built .app}"
[ -d "$APP" ] || { echo "Not found: $APP" >&2; exit 1; }
APP_NAME="$(basename "$APP" .app)"
TARGET="/Applications/$APP_NAME.app"

# Quitting the app would also stop anything it hosts, such as an agent running
# this script. Refuse when any ancestor process lives inside the target bundle.
running_inside_target() {
  local pid=$$ command
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    command="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$command" in *"$TARGET/"*) return 0 ;; esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}
if running_inside_target && [ "${T3_FORK_FORCE_INSTALL:-0}" != "1" ]; then
  echo "Not installing: this is running inside $APP_NAME, and quitting it would stop this process."
  echo "Quit $APP_NAME, then run this in Terminal:"
  echo "  bash \"$0\" \"$APP\""
  exit 3
fi

osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do pgrep -f "$TARGET/Contents/MacOS/" >/dev/null || break; sleep 1; done
if [ -d "$TARGET" ]; then
  backup="$HOME/$APP_NAME (previous).zip"
  rm -f "$backup"
  ditto -c -k --keepParent "$TARGET" "$backup"
  rm -rf "$TARGET"
  echo "Previous app backed up to: $backup"
fi
ditto "$APP" "$TARGET"
open "$TARGET"
echo "Installed and opened $TARGET"
