#!/bin/bash
# Switch the T3 Code service to another installed runtime version, verify it,
# and roll back automatically if it does not come up healthy.
#   switch-runtime.sh <target-version> [<fallback-version>]
# Logs to ~/.t3/runtime/switch-runtime.log and reports via ntfy if configured.
set -uo pipefail
TARGET="${1:?target version}"
FALLBACK="${2:-0.0.45}"
BASE="$HOME/.t3"
STATE="$BASE/runtime/service-state.json"
LOG="$BASE/runtime/switch-runtime.log"
exec >>"$LOG" 2>&1
echo "=== $(date -Is) switching to $TARGET (fallback $FALLBACK)"

notify() {
  local topic
  topic=$(python3 -c "import json;print(json.load(open('$BASE/userdata/ntfy.json'))['topic'])" 2>/dev/null) || return 0
  curl -s -m 10 -X POST https://ntfy.sh -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"topic":sys.argv[1],"title":sys.argv[2],"message":sys.argv[3],"tags":[sys.argv[4]]}))' "$topic" "$1" "$2" "$3")" >/dev/null || true
}

set_active() {
  python3 - "$STATE" "$1" <<'PY'
import json, os, sys
path, version = sys.argv[1], sys.argv[2]
state = json.load(open(path))
state["activeVersion"] = version
state.pop("update", None)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2); f.write("\n"); f.flush(); os.fsync(f.fileno())
os.replace(tmp, path)
PY
}

healthy() {
  # Up, serving the web app, and running the expected runtime.
  for _ in $(seq 1 60); do
    sleep 3
    code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1:3773/ || true)
    if [ "$code" = "200" ] && pgrep -f "runtime/versions/$(printf '%s' "$1" | sed 's/[.+]/\\&/g')/t3 " >/dev/null; then return 0; fi
  done
  return 1
}

for v in "$TARGET" "$FALLBACK"; do
  if [ "$(cat "$BASE/runtime/versions/$v/.install-complete" 2>/dev/null)" != "$v" ]; then
    echo "runtime $v is not installed"; notify "T3 switch aborted" "Runtime $v is not installed; nothing changed." "warning"; exit 1
  fi
done

cp "$STATE" "$STATE.bak"
set_active "$TARGET"
systemctl --user restart t3code.service
if healthy "$TARGET"; then
  echo "switched to $TARGET"
  notify "T3 Code switched to your fork" "Now running $TARGET. Open a thread and add the Desktop panel from the + menu." "white_check_mark"
  exit 0
fi

echo "target unhealthy; rolling back to $FALLBACK"
journalctl --user -u t3code.service -n 40 --no-pager || true
set_active "$FALLBACK"
systemctl --user restart t3code.service
if healthy "$FALLBACK"; then
  notify "T3 fork switch rolled back" "$TARGET did not start; back on $FALLBACK. Details in ~/.t3/runtime/switch-runtime.log." "warning"
else
  notify "T3 Code is down" "Both $TARGET and $FALLBACK failed to start. See ~/.t3/runtime/switch-runtime.log." "rotating_light"
fi
exit 1
