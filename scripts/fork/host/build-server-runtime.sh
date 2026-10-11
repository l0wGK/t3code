#!/bin/bash
set -euo pipefail
VERSION="${1:?version}"
export CI=true PATH="$HOME/.local/share/node-v26.8.2/bin:$HOME/.local/share/vite-plus/bin:$PATH" NODE_OPTIONS=--max-old-space-size=4096 VP_NODE_VERSION=26.8.2
cd ~/t3code
echo "== stamp $VERSION"; node scripts/update-release-package-versions.ts "$VERSION" >/dev/null
echo "== web build"; (cd apps/web && vp run build) > /tmp/build-web.log 2>&1
echo "== server build"; (cd apps/server && node scripts/cli.ts build) > /tmp/build-server.log 2>&1
echo "== exe build"; (cd apps/server && node scripts/cli.ts build-exe) > /tmp/build-exe.log 2>&1
echo "== archive"; rm -rf /tmp/release-cli; node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$VERSION" --resource-monitor-dir "$HOME/.t3/runtime/versions/0.0.45/resource-monitor" --output-dir /tmp/release-cli > /tmp/build-archive.log 2>&1
git checkout -q -- apps/desktop/package.json apps/server/package.json apps/web/package.json packages/contracts/package.json
ls /tmp/release-cli
echo "== BUILD OK"
