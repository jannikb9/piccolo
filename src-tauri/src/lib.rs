mod git;
mod repos;
mod watch;

use repos::Repos;
use tauri::Manager;
use watch::Watchers;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let handle = app.handle();
            let repos = Repos::load(handle);
            let watchers = Watchers::default();
            for path in repos.paths() {
                watchers.watch(handle, &path);
            }
            app.manage(repos);
            app.manage(watchers);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            repos::list_repos,
            repos::add_repo,
            repos::remove_repo,
            repos::worktree_stats,
            repos::changed_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
