#!/bin/bash
# Fork addition: install a built T3 Code .app into /Applications, backing up
# the app it replaces. Used by build-mac-app.sh with T3_FORK_SKIP_INSTALL=1.
#   install-mac-app.sh "/path/to/T3 Code (Alpha).app"
set -euo pipefail
APP="${1:?path to the built .app}"
[ -d "$APP" ] || { echo "Not found: $APP" >&2; exit 1; }
APP_NAME="$(basename "$APP" .app)"
TARGET="/Applications/$APP_NAME.app"

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
