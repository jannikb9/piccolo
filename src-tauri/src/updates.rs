//! Updates from GitHub releases. scripts/release.sh attaches a signed `Piccolo.app.tar.gz` and a
//! `latest.json` to each release; the app checks the latest release's `latest.json`, offers the
//! update with the changelog it carries, then downloads, installs and restarts.

use crate::git::Result;
use serde::Serialize;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update the last check found, for `install_update`.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    version: String,
    current_version: String,
    /// CHANGELOG.md as of the new version: `## <version> — <date>` sections, newest first.
    changelog: String,
}

/// The newer version on GitHub, if there is one.
#[tauri::command]
pub async fn check_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<AvailableUpdate>> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let available = update.as_ref().map(|u| AvailableUpdate {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        changelog: u.body.clone().unwrap_or_default(),
    });
    *pending.0.lock().unwrap() = update;
    Ok(available)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    downloaded: usize,
    /// `None` when the server doesn't say.
    total: Option<u64>,
}

/// Downloads and installs the update the last check found, then restarts into it.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    on_progress: Channel<DownloadProgress>,
) -> Result<()> {
    // A copy, so "Try again" works after a failed download.
    let update = pending.0.lock().unwrap().clone().ok_or("No update to install. Check for updates again.")?;
    let mut downloaded = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk;
                let _ = on_progress.send(DownloadProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}
