//! [worktrunk](https://worktrunk.dev), which Piccolo uses to create and remove worktrees when
//! it's installed (see `git::add_worktree`). It's optional, so the app detects it and offers to
//! install it.
//!
//! The install uses Homebrew when it's there, which keeps track of what's installed and can update
//! and uninstall it. Otherwise it runs worktrunk's own installer, which downloads a prebuilt `wt`
//! from its GitHub release: no Rust needed. `wt` goes to `~/.local/bin`, where Piccolo's
//! `piccolo` command lives too, and neither the user's shell startup files nor their PATH is
//! touched (so there's no uninstall command: delete `wt` and `git-wt` from there).

use crate::git::Result;
use crate::programs;
use crate::repos::blocking;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const INSTALLER_URL: &str = "https://github.com/max-sixty/worktrunk/releases/latest/download/worktrunk-installer.sh";

/// worktrunk's `wt`, if it's installed anywhere Piccolo looks.
pub fn find() -> Option<PathBuf> {
    programs::find("wt")
}

#[tauri::command]
pub async fn worktrunk_installed() -> Result<bool> {
    blocking(|| Ok(find().is_some())).await
}

/// Installs worktrunk, unless it already is.
#[tauri::command]
pub async fn install_worktrunk() -> Result<()> {
    blocking(|| {
        if find().is_some() {
            return Ok(());
        }
        if let Some(brew) = programs::find("brew") {
            return brew_install(&brew).and_then(|()| find().map(|_| ()).ok_or_else(|| "Homebrew installed worktrunk, but wt wasn't found".into()));
        }
        let bin = dirs::home_dir().ok_or("Couldn't find your home folder")?.join(".local/bin");
        let work = std::env::temp_dir().join(format!("piccolo-worktrunk-{}", std::process::id()));
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        let result = run_installer(&work, &bin);
        let _ = std::fs::remove_dir_all(&work);
        result?;
        find().map(|_| ()).ok_or_else(|| format!("worktrunk was installed, but wt isn't in {}", bin.display()))
    })
    .await
}

fn brew_install(brew: &Path) -> Result<()> {
    let path = std::env::join_paths(programs::search_path()).map_err(|e| e.to_string())?;
    let out = Command::new(brew)
        .args(["install", "worktrunk"])
        .env("PATH", path)
        .env("HOMEBREW_NO_ENV_HINTS", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run brew: {e}"))?;
    check("brew install worktrunk failed", &out)
}

fn run_installer(work: &Path, bin: &Path) -> Result<()> {
    let script = work.join("installer.sh");
    let download = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--location", "--max-time", "120", "--output"])
        .arg(&script)
        .arg(INSTALLER_URL)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run curl: {e}"))?;
    check("Couldn't download the worktrunk installer", &download)?;
    let install = Command::new("sh")
        .arg(&script)
        // A "flat" install into `bin`, which leaves the shell setup alone and has no updater.
        .env("WORKTRUNK_UNMANAGED_INSTALL", bin)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run the installer: {e}"))?;
    check("The worktrunk installer failed", &install)
}

fn check(what: &str, out: &std::process::Output) -> Result<()> {
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let detail = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    Err(if detail.is_empty() { what.to_string() } else { format!("{what}: {detail}") })
}
