//! [worktrunk](https://worktrunk.dev), which Piccolo uses to create and remove worktrees when
//! it's installed (see `git::add_worktree`). It's optional, so the app detects it and offers to
//! install it.
//!
//! The install needs Homebrew, which keeps track of what's installed, can update and uninstall it,
//! and checks what it downloads. worktrunk's own installer script would run whatever its latest
//! release serves, unpinned.

use crate::git::Result;
use crate::programs;
use crate::repos::blocking;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// worktrunk's `wt`, if it's installed anywhere Piccolo looks.
pub fn find() -> Option<PathBuf> {
    programs::find("wt")
}

#[derive(Serialize)]
pub struct WorktrunkStatus {
    installed: bool,
    /// Whether Homebrew is there to install it.
    homebrew: bool,
}

#[tauri::command]
pub async fn worktrunk_status() -> Result<WorktrunkStatus> {
    blocking(|| Ok(WorktrunkStatus { installed: find().is_some(), homebrew: programs::find("brew").is_some() })).await
}

/// Installs worktrunk, unless it already is.
#[tauri::command]
pub async fn install_worktrunk() -> Result<()> {
    blocking(|| {
        if find().is_some() {
            return Ok(());
        }
        let brew = programs::find("brew").ok_or("Installing worktrunk needs Homebrew")?;
        brew_install(&brew)?;
        find().map(|_| ()).ok_or_else(|| "Homebrew installed worktrunk, but wt wasn't found".into())
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

fn check(what: &str, out: &std::process::Output) -> Result<()> {
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let detail = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    Err(if detail.is_empty() { what.to_string() } else { format!("{what}: {detail}") })
}
