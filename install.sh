#!/bin/sh
# Installs (or updates) Piccolo from the latest GitHub release:
#   curl -fsSL https://raw.githubusercontent.com/jannikb9/piccolo/main/install.sh | sh
#
# The app goes to /Applications (or ~/Applications when that isn't writable) and the `piccolo`
# command is linked into ~/.local/bin.
set -eu

url="https://github.com/jannikb9/piccolo/releases/latest/download/Piccolo.zip"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Piccolo runs on macOS only." >&2
  exit 1
fi

apps="/Applications"
if [ ! -w "$apps" ]; then
  apps="$HOME/Applications"
  mkdir -p "$apps"
fi
bin="$HOME/.local/bin"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading Piccolo…"
# HTTPS only, also after GitHub redirects to its download host.
curl -fSL --progress-bar "$url" -o "$tmp/Piccolo.zip"
ditto -x -k "$tmp/Piccolo.zip" "$tmp"

# Replace the bundle rather than copying over it: macOS kills a binary that was overwritten in place.
rm -rf "$apps/Piccolo.app"
mv "$tmp/Piccolo.app" "$apps/Piccolo.app"

mkdir -p "$bin"
ln -sf "$apps/Piccolo.app/Contents/MacOS/piccolo" "$bin/piccolo"

echo "Installed $apps/Piccolo.app and $bin/piccolo"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "Add $bin to your PATH to use the piccolo command." ;;
esac
if pgrep -xq piccolo; then
  echo "Piccolo is running: quit and reopen it to use the new version."
fi
if ! command -v wt >/dev/null 2>&1; then
  echo "Optional: Piccolo offers to install worktrunk on first launch, and then creates worktrees with it."
fi
