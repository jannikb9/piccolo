pub mod cli;
mod comments;
mod git;
mod imports;
mod menu;
mod navigate;
mod programs;
mod repos;
mod requests;
mod sessions;
mod updates;
mod watch;
mod worktrunk;

use repos::Repos;
use tauri::Manager;
use updates::PendingUpdate;
use watch::Watchers;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate::default())
        .setup(|app| {
            menu::install(app)?;
            let handle = app.handle();
            let repos = Repos::load(handle);
            let watchers = Watchers::default();
            for path in repos.paths() {
                watchers.watch(handle, &path);
            }
            watchers.watch_comments(handle);
            watchers.watch_sessions(handle);
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
            repos::commits,
            repos::remote_branches,
            repos::fetch_remotes,
            repos::add_worktree,
            repos::remove_worktree,
            repos::file_versions,
            comments::list_threads,
            comments::add_thread,
            comments::add_general_thread,
            comments::reply_thread,
            comments::edit_comment,
            comments::set_thumbs_up,
            comments::set_thread_resolved,
            comments::set_thread_dismissed,
            comments::delete_comment,
            comments::attachment_data,
            sessions::list_sessions,
            sessions::session_activity,
            requests::send_comments,
            requests::copy_prompt,
            requests::request_review,
            requests::stop_request,
            navigate::find_symbol,
            navigate::file_text,
            updates::check_update,
            updates::install_update,
            worktrunk::worktrunk_status,
            worktrunk::install_worktrunk,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
