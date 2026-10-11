# l0wGK/t3code fork notes

This is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Read this
before changing fork code; upstream conventions in AGENTS.md still apply.

## Branches

- `live`: the deployed fork. It is upstream tag `v0.0.45` (the release the official mobile and
  desktop clients speak) plus the fork commits. The fork builds and releases from here.
- `main`: an early port of the fork features onto upstream `main`, which uses the newer V2
  orchestration. It is not deployed.
- `upstream` remote: pingdotgg/t3code. To move to a newer upstream release, rebase the fork
  commits from `live` onto the new tag, then rebuild and redeploy.

Fork commits are kept in their own files where possible, with small, commented hooks
(`// Fork addition: ...`) in upstream files, so upstream changes merge with few conflicts.

## Features

| Feature                 | Where                                                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ntfy push notifications | `apps/server/src/notifications/NtfyNotifier.ts`                                                              | Alerts on finished, failed, approval, input. Config `<stateDir>/ntfy.json`. Docs: `docs/user/ntfy-notifications.md`.                                                                                                                                                                                                                                              |
| Desktop panel           | `apps/server/src/desktop/` (proxy and viewer page), `apps/web/src/components/remoteDesktop/DesktopPanel.tsx` | noVNC RFB core behind `/api/desktop`, signed session paths (the token names the desktop), postMessage to the panel toolbar. Several desktops via `desktops` in the config; agents claim one with `~/desktop.sh claim`. Clipboard sync and Mac Cmd-shortcut mapping live in `viewerPage.ts`. Config `<stateDir>/desktop.json`. Docs: `docs/user/desktop-panel.md`. |
| Desktop pop-out         | `apps/desktop/src/window/desktopViewerPopup.ts`                                                              | The Electron window-open handler opens viewer URLs in an app window.                                                                                                                                                                                                                                                                                              |
| Mac in-app updates      | `apps/desktop/src/updates/ForkMacUpdater.ts`, `.github/workflows/fork-mac-release.yml`                       | Replaces electron-updater on macOS (Squirrel.Mac needs a Developer ID). Each push to `live` builds an ad-hoc signed app and publishes a `fork-mac-<n>` release with a manifest in its notes.                                                                                                                                                                      |
| Mac build script        | `scripts/fork/build-mac-app.sh`, `scripts/fork/install-mac-app.sh`                                           | Local Mac build. `T3_FORK_SKIP_INSTALL=1` builds only. The install script refuses to replace the app it runs inside.                                                                                                                                                                                                                                              |
| Host setup              | `scripts/fork/host/`                                                                                         | The desktop service (TigerVNC Xvnc, fluxbox, tint2, websockify, Firefox), the runtime build and switch scripts. See its README.                                                                                                                                                                                                                                   |

Upstream workflows are disabled on the fork; only `fork-mac-release.yml` runs.

## Versions

- Server runtimes: `0.0.45+l0wgk.N`, built with `scripts/fork/host/build-server-runtime.sh`.
- Mac app: `0.0.45+l0wgk.(run_number + 1)`, set by CI. `scripts/fork/VERSION` holds the base.
- SemVer ignores `+build` metadata, so the fork compares builds itself (`compareForkVersions`).
  macOS `CFBundleShortVersionString` carries only `0.0.45`.

## Pitfalls

- Restarting the T3 server stops every process in its service cgroup, including agents and
  anything they started. Run long-lived processes as their own systemd units, and schedule
  server switches with `systemd-run --user --on-active=...`.
- `pkill -f <pattern>` from an agent shell also matches that shell's own command line. Kill by
  PID, or anchor the pattern (`pgrep -f "^firefox ..."`).
- `vp i` in a non-interactive shell needs `CI=true`. Large installs and builds need
  `NODE_OPTIONS=--max-old-space-size=4096`.
- `build-exe` needs Node 25.7 or newer; releases use 26.8.2 (`SEA_NODE_VERSION`).
- The v0.0.45 language service rejects `Date.now()`, global `fetch`, and Node built-ins in Effect
  code. Use `Clock` and `HttpClient`, or a commented `@effect-diagnostics ...:off` for adapters.
- `raw.githubusercontent.com` caches branch URLs for about five minutes. Hand out commit URLs.
- The viewer page is a TypeScript template string: escape backticks and `${` in its script.
- Test clipboard features with a second X display and its own Firefox. The desktop's own
  Firefox shares the clipboard it would be testing.
