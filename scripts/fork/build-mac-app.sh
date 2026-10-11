#!/bin/bash
# Fork addition: build this fork's T3 Code desktop app on a Mac and install it
# in /Applications, replacing the official app of the same name (a backup zip
# is kept in your home folder).
#
#   curl -fsSL https://raw.githubusercontent.com/l0wGK/t3code/live/scripts/fork/build-mac-app.sh | bash
#
# raw.githubusercontent.com caches a branch URL for about five minutes, so
# right after a push it can serve the previous script. Agents should fetch by
# commit instead: …/l0wGK/t3code/<commit-sha>/scripts/fork/build-mac-app.sh
#
# The build is unsigned and has no update feed, so it never replaces itself
# with an official release. Rerun the command to rebuild after fork changes.
#
# T3_FORK_SKIP_INSTALL=1 builds without touching /Applications and prints the
# install command instead. The install step also refuses to quit or replace
# the app when this script runs inside it (an agent hosted by that app).
set -euo pipefail

REPO_URL="${T3_FORK_REPO:-https://github.com/l0wGK/t3code.git}"
BRANCH="${T3_FORK_BRANCH:-live}"
SRC="${T3_FORK_DIR:-$HOME/t3code-fork}"
# The single-executable server needs this exact Node (keep in step with
# SEA_NODE_VERSION in apps/server/vite.config.ts).
NODE_VERSION=26.8.2

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "Run this on your Mac."
case "$(uname -m)" in
  arm64) ARCH=arm64; RUST_TARGET=aarch64-apple-darwin ;;
  x86_64) ARCH=x64; RUST_TARGET=x86_64-apple-darwin ;;
  *) die "Unsupported Mac architecture: $(uname -m)" ;;
esac

step "Checking Xcode Command Line Tools"
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install || true
  die "Finish the Command Line Tools install in the dialog that opened, then run this command again."
fi

step "Checking Rust"
if ! command -v cargo >/dev/null 2>&1 && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
export PATH="$HOME/.cargo/bin:$PATH"
# The resource monitor's dependencies need a recent stable (sysinfo needs 1.95).
# Build with stable explicitly rather than changing your default toolchain.
MIN_RUST_MINOR=95
rustup toolchain install stable --profile minimal --no-self-update >/dev/null
export RUSTUP_TOOLCHAIN=stable
rust_minor="$(rustc --version | sed -E 's/^rustc 1\.([0-9]+).*/\1/')"
if [ "${rust_minor:-0}" -lt "$MIN_RUST_MINOR" ]; then
  rustup update stable --no-self-update >/dev/null
  rust_minor="$(rustc --version | sed -E 's/^rustc 1\.([0-9]+).*/\1/')"
fi
[ "${rust_minor:-0}" -ge "$MIN_RUST_MINOR" ] || die "Rust 1.$MIN_RUST_MINOR or newer is required; found $(rustc --version)."
rustup target add --toolchain stable "$RUST_TARGET" >/dev/null

step "Checking Node $NODE_VERSION (private copy, does not touch any Node you have)"
NODE_DIR="$HOME/.local/share/node-v$NODE_VERSION"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  tarball="node-v$NODE_VERSION-darwin-$ARCH.tar.xz"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$tarball"
  expected="$(curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | awk -v f="$tarball" '$2 == f { print $1 }')"
  actual="$(shasum -a 256 "$tmp/$tarball" | awk '{ print $1 }')"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || die "Node download checksum mismatch."
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$tarball" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
fi
export PATH="$NODE_DIR/bin:$PATH"
export VP_NODE_VERSION="$NODE_VERSION"

step "Checking the Vite+ (vp) build tool"
for dir in "$HOME/.vite-plus/bin" "$HOME/.local/share/vite-plus/bin"; do
  [ -d "$dir" ] && export PATH="$dir:$PATH"
done
if ! command -v vp >/dev/null 2>&1; then
  curl -fsSL https://vite.plus | bash
  for dir in "$HOME/.vite-plus/bin" "$HOME/.local/share/vite-plus/bin"; do
    [ -d "$dir" ] && export PATH="$dir:$PATH"
  done
  command -v vp >/dev/null 2>&1 || die "vp was installed but is not on PATH; open a new Terminal and rerun."
fi
# Keep our pinned Node ahead of any Node shims vp added.
export PATH="$NODE_DIR/bin:$PATH"

step "Fetching $BRANCH from $REPO_URL into $SRC"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch --quiet origin "$BRANCH"
  git -C "$SRC" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
  git -C "$SRC" reset --quiet --hard "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$SRC"
fi
cd "$SRC"
VERSION="$(cat scripts/fork/VERSION)"

step "Building T3 Code $VERSION for $ARCH (this takes a while)"
# T3 Connect uses the same public identifiers as official builds.
cp .env.example .env
export CI=true NODE_OPTIONS=--max-old-space-size=6144
# Install first: the version script imports workspace dependencies.
vp i
node scripts/update-release-package-versions.ts "$VERSION" >/dev/null
rm -rf release
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch "$ARCH" --build-version "$VERSION"
git checkout --quiet -- apps/desktop/package.json apps/server/package.json apps/web/package.json packages/contracts/package.json

# The artifact script copies only files out of its temporary stage, so the
# .app is only inside the zip.
ZIP="$(find release -maxdepth 1 -name '*.zip' | head -1)"
[ -n "$ZIP" ] || die "Build finished but no zip was found under $SRC/release."
ditto -x -k "$ZIP" "release/mac-$ARCH"
APP="$(find release -maxdepth 2 -name '*.app' -type d | head -1)"
[ -n "$APP" ] || die "Build finished but no .app was found under $SRC/release."
APP_NAME="$(basename "$APP" .app)"
TARGET="/Applications/$APP_NAME.app"
APP_ABS="$SRC/$APP"

if [ "${T3_FORK_SKIP_INSTALL:-0}" = "1" ]; then
  step "Built $APP_NAME $VERSION (not installed)"
  echo "App: $APP_ABS"
  echo "To install, quit $APP_NAME and run:"
  echo "  bash \"$SRC/scripts/fork/install-mac-app.sh\" \"$APP_ABS\""
  exit 0
fi

step "Installing $APP_NAME to /Applications"
bash "$SRC/scripts/fork/install-mac-app.sh" "$APP_ABS"

step "Done: $APP_NAME $VERSION is installed and running."
echo "To go back to the official app, download it from https://t3.codes or unzip the backup above into /Applications."
