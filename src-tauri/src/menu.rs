//! The native menu bar: Tauri's default menus plus "Check for Updates…" and "Settings…" (⌘,) in the
//! app menu, and "Reload" (⌘R) and "Toggle Sidebar" (⌃⌘S) in the View menu.

use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{App, Emitter, Manager};

const SETTINGS_ID: &str = "settings";
const RELOAD_ID: &str = "reload";
/// Menu item id, and the event asking the UI to show or hide the worktree sidebar.
const TOGGLE_SIDEBAR: &str = "toggle-sidebar";
/// Asks the UI to open its settings dialog.
pub const OPEN_SETTINGS: &str = "open-settings";
/// Menu item id, and the event asking the UI to check for a new version and say if there's none.
const CHECK_FOR_UPDATES: &str = "check-for-updates";

pub fn install(app: &App) -> tauri::Result<()> {
    let handle = app.handle();
    let menu = Menu::default(handle)?;

    // On macOS the first submenu is the app menu: About, Services, Hide, Quit.
    #[cfg(target_os = "macos")]
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
        let updates = MenuItem::with_id(handle, CHECK_FOR_UPDATES, "Check for Updates…", true, None::<&str>)?;
        let settings = MenuItem::with_id(handle, SETTINGS_ID, "Settings…", true, Some("CmdOrCtrl+,"))?;
        app_menu.insert_items(&[&updates, &PredefinedMenuItem::separator(handle)?, &settings], 1)?;
    }

    for item in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = item {
            if submenu.text()? == "View" {
                let reload = MenuItem::with_id(handle, RELOAD_ID, "Reload", true, Some("CmdOrCtrl+R"))?;
                let sidebar = MenuItem::with_id(handle, TOGGLE_SIDEBAR, "Toggle Sidebar", true, Some("Ctrl+Cmd+S"))?;
                submenu.insert_items(&[&reload, &sidebar, &PredefinedMenuItem::separator(handle)?], 0)?;
            }
        }
    }

    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id() == SETTINGS_ID {
            let _ = app.emit(OPEN_SETTINGS, ());
        } else if event.id() == CHECK_FOR_UPDATES {
            let _ = app.emit(CHECK_FOR_UPDATES, ());
        } else if event.id() == TOGGLE_SIDEBAR {
            let _ = app.emit(TOGGLE_SIDEBAR, ());
        } else if event.id() == RELOAD_ID {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.reload();
            }
        }
    });
    Ok(())
}
