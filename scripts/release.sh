#!/bin/sh
# Builds a universal (Apple Silicon + Intel), ad-hoc signed Piccolo.app and publishes it as a
# GitHub release tagged with the version in src-tauri/tauri.conf.json. install.sh downloads the
# latest release's Piccolo.zip.
#
# Needs: rustup targets aarch64-apple-darwin and x86_64-apple-darwin, and `gh` logged in.
set -eu
cd "$(dirname "$0")/.."

version="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
tag="v$version"

if [ -n "$(git status --porcelain)" ]; then
  echo "Commit your changes first: the release is tagged at HEAD." >&2
  exit 1
fi
if gh release view "$tag" >/dev/null 2>&1; then
  echo "Release $tag exists already: bump the version in src-tauri/tauri.conf.json." >&2
  exit 1
fi

pnpm tauri build --target universal-apple-darwin --bundles app

app="src-tauri/target/universal-apple-darwin/release/bundle/macos/Piccolo.app"
codesign --verify --strict "$app"
zip="src-tauri/target/universal-apple-darwin/release/bundle/Piccolo.zip"
rm -f "$zip"
ditto -c -k --keepParent "$app" "$zip"

git push origin HEAD
gh release create "$tag" "$zip" --title "Piccolo $version" --generate-notes --target "$(git rev-parse HEAD)"
