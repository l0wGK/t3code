#!/bin/bash
# Waits until no thread has a turn running, then switches the server runtime with
# switch-runtime.sh. A restart stops running agents, so deploys wait for a quiet moment.
#   systemd-run --user --unit=t3-switch-when-idle ~/.t3/runtime/switch-when-idle.sh <target> <fallback> [max-hours]
# Reads the server database read-only; two idle checks 10 seconds apart count as quiet.
set -euo pipefail
target="${1:?target version}"
fallback="${2:?fallback version}"
deadline=$(($(date +%s) + ${3:-24} * 3600))
db="$HOME/.t3/userdata/state.sqlite"
log="$HOME/.t3/runtime/switch-runtime.log"

running_turns() {
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const row = db.prepare(
      "select count(*) as n from projection_thread_sessions where active_turn_id is not null",
    ).get();
    console.log(row.n);
  ' "$db"
}

echo "=== $(date -Is) waiting for idle to switch to $target (fallback $fallback)" >>"$log"
idle=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$(running_turns)" = "0" ]; then idle=$((idle + 1)); else idle=0; fi
  if [ "$idle" -ge 2 ]; then
    exec "$HOME/.t3/runtime/switch-runtime.sh" "$target" "$fallback"
  fi
  sleep 10
done
echo "gave up waiting for idle; still on the current runtime" >>"$log"
exit 1
