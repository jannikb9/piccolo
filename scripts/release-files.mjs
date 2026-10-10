// Writes the files scripts/release.sh publishes with a release, into <out dir>:
//   latest.json  what the app's updater reads (src-tauri/src/updates.rs): the version, the signed
//                download and CHANGELOG.md's release sections, shown when it offers the update
//   notes.md     the GitHub release's description: this version's CHANGELOG.md section
//
// Usage: node scripts/release-files.mjs <version> <signed Piccolo.app.tar.gz> <out dir>
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [version, tarball, outDir] = process.argv.slice(2);
const repo = "jannikb9/piccolo";

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
// Everything from the first `## <version>` heading on; the intro above it is for contributors.
const releases = changelog.slice(changelog.search(/^## /m)).trim();
const section = releases
  .split(/^(?=## )/m)
  .find((s) => s.match(/^## (\S+)/)?.[1] === version);
if (!section) {
  console.error(`CHANGELOG.md has no "## ${version} — <date>" section.`);
  process.exit(1);
}

const download = {
  url: `https://github.com/${repo}/releases/download/v${version}/${basename(tarball)}`,
  signature: readFileSync(`${tarball}.sig`, "utf8").trim(),
};
const manifest = {
  version,
  notes: releases,
  pub_date: new Date().toISOString(),
  // The build is universal: one download for both architectures.
  platforms: { "darwin-aarch64": download, "darwin-x86_64": download },
};
writeFileSync(join(outDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(outDir, "notes.md"), `${section.replace(/^## .*\n/, "").trim()}\n`);
