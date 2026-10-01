pub mod cli;
mod comments;
mod git;
mod imports;
mod menu;
mod navigate;
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
            menu::install(app)?;
            let handle = app.handle();
            let repos = Repos::load(handle);
            let watchers = Watchers::default();
            for path in repos.paths() {
                watchers.watch(handle, &path);
            }
            watchers.watch_comments(handle);
            app.manage(repos);
            app.manage(watchers);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            repos::list_repos,
            repos::add_repo,
            repos::remove_repo,
            repos::reorder_repos,
            repos::worktree_stats,
            repos::changed_files,
            repos::diff_patch,
            repos::remote_branches,
            repos::fetch_remotes,
            repos::add_worktree,
            repos::remove_worktree,
            repos::file_versions,
            comments::list_threads,
            comments::add_thread,
            comments::reply_thread,
            comments::set_thread_resolved,
            comments::delete_comment,
            comments::attachment_data,
            navigate::find_symbol,
            navigate::file_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
