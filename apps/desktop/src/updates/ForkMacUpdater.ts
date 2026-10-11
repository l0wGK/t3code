// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off - Like ElectronUpdater, this adapter replaces a promise-based npm updater and is built in the Electron layer, before the platform FileSystem/HttpClient services exist.
/**
 * Fork addition: a macOS `ElectronUpdater` for this fork's unsigned builds.
 *
 * electron-updater installs macOS updates through Squirrel.Mac, which only
 * accepts updates signed by the same Developer ID as the running app. Fork
 * builds are ad-hoc signed, so this layer checks the fork's GitHub Releases
 * itself, downloads and verifies the app zip, and on install hands off to a
 * detached script that replaces the bundle after the app quits and relaunches
 * it. DesktopUpdates drives it through the same events and methods as
 * electron-updater, so the update state machine, IPC, and UI are unchanged.
 *
 * Releases are published by .github/workflows/fork-mac-release.yml. Each one
 * carries a `<!-- fork-update {...} -->` manifest in its body naming the
 * version and, per architecture, the zip asset and its SHA-256.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { EventEmitter } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ElectronUpdater,
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
} from "../electron/ElectronUpdater.ts";

const execFile = promisify(NodeChildProcess.execFile);

const FORK_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z-]+\.(\d+))?$/;
const MANIFEST_PATTERN = /<!--\s*fork-update\s+(\{[\s\S]*?\})\s*-->/;
const RELEASE_TAG_PREFIX = "fork-mac-";

export interface ForkVersion {
  readonly core: readonly [number, number, number];
  /** The fork build number; 0 for an upstream version. */
  readonly build: number;
}

/** Parses `0.0.45` or `0.0.45+l0wgk.12`. */
export function parseForkVersion(version: string): ForkVersion | null {
  const match = FORK_VERSION_PATTERN.exec(version.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    build: match[4] === undefined ? 0 : Number(match[4]),
  };
}

/**
 * Orders by upstream version, then fork build. SemVer ignores build metadata,
 * so `+l0wgk.2` would otherwise never count as newer than `+l0wgk.1`.
 */
export function compareForkVersions(left: string, right: string): number {
  const a = parseForkVersion(left);
  const b = parseForkVersion(right);
  if (a === null || b === null) return 0;
  for (let index = 0; index < 3; index += 1) {
    const difference = a.core[index]! - b.core[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return Math.sign(a.build - b.build);
}

export interface ForkReleaseCandidate {
  readonly version: string;
  readonly zipUrl: string;
  readonly sha256: string;
  readonly size: number | null;
  readonly htmlUrl: string | null;
}

interface GitHubReleaseAsset {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
  readonly size?: unknown;
}

/** Picks the newest published fork release for `arch` that is newer than `currentVersion`. */
export function selectForkRelease(
  releases: unknown,
  arch: string,
  currentVersion: string,
): ForkReleaseCandidate | null {
  if (!Array.isArray(releases)) return null;
  let best: ForkReleaseCandidate | null = null;
  for (const release of releases as Array<Record<string, unknown>>) {
    if (release.draft === true) continue;
    if (typeof release.tag_name !== "string" || !release.tag_name.startsWith(RELEASE_TAG_PREFIX)) {
      continue;
    }
    const manifestMatch = typeof release.body === "string" && MANIFEST_PATTERN.exec(release.body);
    if (!manifestMatch) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestMatch[1]!);
    } catch {
      continue;
    }
    if (typeof manifest !== "object" || manifest === null) continue;
    const { version, assets } = manifest as { version?: unknown; assets?: unknown };
    if (typeof version !== "string" || parseForkVersion(version) === null) continue;
    const entry =
      typeof assets === "object" && assets !== null
        ? (assets as Record<string, unknown>)[arch]
        : undefined;
    if (typeof entry !== "object" || entry === null) continue;
    const { name, sha256 } = entry as { name?: unknown; sha256?: unknown };
    if (typeof name !== "string" || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
      continue;
    }
    const asset = (Array.isArray(release.assets) ? release.assets : []).find(
      (candidate: GitHubReleaseAsset) => candidate.name === name,
    ) as GitHubReleaseAsset | undefined;
    if (typeof asset?.browser_download_url !== "string") continue;
    if (compareForkVersions(version, currentVersion) <= 0) continue;
    if (best !== null && compareForkVersions(version, best.version) <= 0) continue;
    best = {
      version,
      zipUrl: asset.browser_download_url,
      sha256,
      size: typeof asset.size === "number" ? asset.size : null,
      htmlUrl: typeof release.html_url === "string" ? release.html_url : null,
    };
  }
  return best;
}

/** Reads `owner/repo` from electron-builder's app-update.yml (github provider). */
export function parseUpdateRepository(appUpdateYml: string): string | null {
  const owner = /^owner:\s*['"]?([^'"\s]+)/m.exec(appUpdateYml)?.[1];
  const repo = /^repo:\s*['"]?([^'"\s]+)/m.exec(appUpdateYml)?.[1];
  return owner && repo ? `${owner}/${repo}` : null;
}

/** The `.app` bundle containing an executable path, if any. */
export function appBundlePath(executablePath: string): string | null {
  return /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(executablePath)?.[1] ?? null;
}

/**
 * Replaces the app after the running process exits, restoring the previous
 * bundle if the copy fails, then relaunches. Arguments: pid, staged app,
 * target app, log file.
 */
export const INSTALL_SCRIPT = `#!/bin/bash
set -u
pid="$1"; staged="$2"; target="$3"; log="$4"
exec >>"$log" 2>&1
echo "=== $(date) installing $staged over $target after pid $pid exits"
for _ in $(seq 1 600); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$pid" 2>/dev/null; then echo "app did not quit; giving up"; exit 1; fi
backup="$(dirname "$staged")/previous.app"
rm -rf "$backup"
if ! mv "$target" "$backup"; then echo "could not move the current app aside"; open "$target"; exit 1; fi
if ditto "$staged" "$target"; then
  xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
  rm -rf "$backup" "$staged"
  echo "installed"
else
  echo "copy failed; restoring the previous app"
  rm -rf "$target"
  mv "$backup" "$target"
fi
open "$target"
`;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.sync(() => {
  const events = new EventEmitter();
  const workDir = NodePath.join(NodeOS.tmpdir(), "t3-fork-update");
  let channel: string | null = null;
  let available: ForkReleaseCandidate | null = null;
  let staged: { readonly version: string; readonly appPath: string } | null = null;

  const currentVersion = () => Electron.app.getVersion();
  const arch = () => process.arch;

  const repository = async (): Promise<string> => {
    const yml = await NodeFSP.readFile(
      NodePath.join(process.resourcesPath, "app-update.yml"),
      "utf8",
    );
    const repo = parseUpdateRepository(yml);
    if (repo === null) throw new Error("app-update.yml does not name a GitHub repository.");
    return repo;
  };

  const check = async () => {
    events.emit("checking-for-update");
    const response = await fetch(
      `https://api.github.com/repos/${await repository()}/releases?per_page=30`,
      {
        headers: { accept: "application/vnd.github+json", "user-agent": "t3code-fork-updater" },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) throw new Error(`GitHub releases responded ${response.status}.`);
    available = selectForkRelease(await response.json(), arch(), currentVersion());
    if (available === null) {
      events.emit("update-not-available", { version: currentVersion() });
    } else {
      events.emit("update-available", { version: available.version });
    }
  };

  const download = async () => {
    const release = available;
    if (release === null) throw new Error("No update is available to download.");
    const versionDir = NodePath.join(workDir, release.version);
    await NodeFSP.rm(versionDir, { recursive: true, force: true });
    await NodeFSP.mkdir(versionDir, { recursive: true });
    const zipPath = NodePath.join(versionDir, "update.zip");

    const response = await fetch(release.zipUrl, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || response.body === null) {
      throw new Error(`Downloading the update failed with ${response.status}.`);
    }
    const total = Number(response.headers.get("content-length")) || release.size || 0;
    const hash = NodeCrypto.createHash("sha256");
    let transferred = 0;
    let lastPercent = -1;
    const startedAt = Date.now();
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      transferred += chunk.length;
      const percent = total > 0 ? Math.min(100, (transferred / total) * 100) : 0;
      if (Math.floor(percent) !== lastPercent) {
        lastPercent = Math.floor(percent);
        const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
        events.emit("download-progress", {
          percent,
          transferred,
          total,
          bytesPerSecond: transferred / seconds,
        });
      }
    });
    await pipeline(body, NodeFS.createWriteStream(zipPath));
    if (hash.digest("hex") !== release.sha256) {
      throw new Error("The downloaded update failed its checksum.");
    }

    const extractDir = NodePath.join(versionDir, "app");
    await execFile("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir]);
    await NodeFSP.rm(zipPath, { force: true });
    const appName = (await NodeFSP.readdir(extractDir)).find((name) => name.endsWith(".app"));
    if (appName === undefined) throw new Error("The update archive contains no app.");
    const appPath = NodePath.join(extractDir, appName);
    const { stdout } = await execFile("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleShortVersionString",
      NodePath.join(appPath, "Contents", "Info.plist"),
    ]);
    if (stdout.trim() !== release.version) {
      throw new Error(`The update reports version ${stdout.trim()}, not ${release.version}.`);
    }
    staged = { version: release.version, appPath };
    events.emit("update-downloaded", { version: release.version });
  };

  const install = () => {
    if (staged === null) throw new Error("No downloaded update is ready to install.");
    const target = appBundlePath(process.execPath);
    if (target === null) throw new Error("The running app is not inside an .app bundle.");
    const scriptPath = NodePath.join(workDir, "install.sh");
    NodeFS.mkdirSync(workDir, { recursive: true });
    NodeFS.writeFileSync(scriptPath, INSTALL_SCRIPT, { mode: 0o755 });
    const child = NodeChildProcess.spawn(
      "/bin/bash",
      [
        scriptPath,
        String(process.pid),
        staged.appPath,
        target,
        NodePath.join(workDir, "install.log"),
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    // A normal quit lets the desktop lifecycle stop backends before exiting;
    // the script waits for this process to be gone.
    Electron.app.quit();
  };

  return ElectronUpdater.of({
    setFeedURL: () => Effect.void,
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: (value) =>
      Effect.sync(() => {
        channel = value;
      }),
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.succeed(false),
    setAllowDowngrade: () => Effect.void,
    setFullChangelog: () => Effect.void,
    setDisableDifferentialDownload: () => Effect.void,
    checkForUpdates: Effect.tryPromise({
      try: check,
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }),
    downloadUpdate: Effect.tryPromise({
      try: download,
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }),
    quitAndInstall: ({ isSilent, isForceRunAfter }) =>
      Effect.try({
        try: install,
        catch: (cause) =>
          new ElectronUpdaterQuitAndInstallError({ channel, isSilent, isForceRunAfter, cause }),
      }),
    on: (eventName, listener) => {
      const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          events.on(eventName, untypedListener);
        }),
        () =>
          Effect.sync(() => {
            events.removeListener(eventName, untypedListener);
          }),
      );
    },
  });
});

export const layer = Layer.effect(ElectronUpdater, make);
