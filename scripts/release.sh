#!/bin/sh
# Builds a universal (Apple Silicon + Intel), ad-hoc signed Piccolo.app and publishes it as a
# GitHub release tagged with the version in src-tauri/tauri.conf.json. install.sh downloads the
# latest release's Piccolo.zip; the app updates itself from its latest.json and Piccolo.app.tar.gz.
#
# Needs: rustup targets aarch64-apple-darwin and x86_64-apple-darwin, `gh` logged in, a
# "## <version> — <date>" section in CHANGELOG.md, and the updater's signing key at
# ~/.tauri/piccolo.key (its public half is in tauri.conf.json; installed apps only accept updates
# signed with it). It asks for the key's passphrase (scripts/signing-key-passphrase.sh sets it),
# unless TAURI_SIGNING_PRIVATE_KEY_PASSWORD has it.
set -eu
cd "$(dirname "$0")/.."

version="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
tag="v$version"
key="$HOME/.tauri/piccolo.key"

if [ -n "$(git status --porcelain)" ]; then
  echo "Commit your changes first: the release is tagged at HEAD." >&2
  exit 1
fi
if gh release view "$tag" >/dev/null 2>&1; then
  echo "Release $tag exists already: bump the version in src-tauri/tauri.conf.json." >&2
  exit 1
fi
if ! grep -q "^## $version " CHANGELOG.md; then
  echo "Describe $version in CHANGELOG.md first (a \"## $version — <date>\" section)." >&2
  exit 1
fi
if [ ! -f "$key" ]; then
  echo "The updater's signing key $key is missing." >&2
  exit 1
fi

# Older pnpm ignores minimumReleaseAge in pnpm-workspace.yaml.
case "$(pnpm --version)" in
  10.1[6-9].* | 10.[2-9][0-9].* | 1[1-9].*) ;;
  *)
    echo "pnpm $(pnpm --version) is too old: the release needs 10.16 or later (package.json's packageManager)." >&2
    exit 1
    ;;
esac

if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+set}" ]; then
  if [ ! -t 0 ]; then
    echo "Run this in a terminal: it asks for the signing key's passphrase." >&2
    exit 1
  fi
  printf "Passphrase for %s: " "$key"
  trap 'stty echo' EXIT INT TERM
  stty -echo
  read -r TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  stty echo
  echo
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
# A wrong passphrase fails now, not after the build.
check="$(mktemp -d)"
echo "passphrase check" > "$check/file"
if ! pnpm tauri signer sign -f "$key" "$check/file" >/dev/null 2>&1; then
  rm -rf "$check"
  echo "That passphrase doesn't open $key." >&2
  exit 1
fi
rm -rf "$check"

# Build exactly the locked dependencies: a release must not pick up a newly published version.
pnpm install --frozen-lockfile

# The build reads the key from its path (`signer sign` above takes it only as -f).
export TAURI_SIGNING_PRIVATE_KEY="$key"
pnpm tauri build --target universal-apple-darwin --bundles app \
  --config '{"bundle":{"createUpdaterArtifacts":true}}' -- --locked

bundle="src-tauri/target/universal-apple-darwin/release/bundle"
app="$bundle/macos/Piccolo.app"
codesign --verify --strict "$app"
zip="$bundle/Piccolo.zip"
rm -f "$zip"
ditto -c -k --keepParent "$app" "$zip"
tarball="$bundle/macos/Piccolo.app.tar.gz"
node scripts/release-files.mjs "$version" "$tarball" "$bundle"

git push origin HEAD
gh release create "$tag" "$zip" "$tarball" "$bundle/latest.json" \
  --title "Piccolo $version" --notes-file "$bundle/notes.md" --target "$(git rev-parse HEAD)"
