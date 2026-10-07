#!/bin/sh
# Sets or changes the passphrase of the updater's signing key, keeping the key itself: installed
# apps only accept updates signed with it. scripts/release.sh asks for the passphrase.
#
# Usage: scripts/signing-key-passphrase.sh [key file, default ~/.tauri/piccolo.key]
#
# Needs minisign (brew install minisign): Tauri keeps the key as a minisign secret key, base64
# encoded on one line.
set -eu

key="${1:-$HOME/.tauri/piccolo.key}"

if ! command -v minisign >/dev/null 2>&1; then
  echo "Install minisign first: brew install minisign" >&2
  exit 1
fi
if [ ! -f "$key" ]; then
  echo "$key doesn't exist." >&2
  exit 1
fi

umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

base64 -d -i "$key" -o "$tmp/key"
echo "minisign asks for the current passphrase (just press Enter if there is none), then the new one."
minisign -C -s "$tmp/key"

# Swapped in whole, so an interrupted run leaves the old key as it was.
base64 -i "$tmp/key" | tr -d '\n' > "$key.new"
chmod 600 "$key.new"
mv "$key.new" "$key"
echo "Done. Keep a backup of $key somewhere safe (it's useless without the passphrase)."
