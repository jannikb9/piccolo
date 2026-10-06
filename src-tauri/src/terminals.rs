//! Starting an agent's CLI in the user's terminal, for agents without a desktop app or users who
//! work in a terminal. Each terminal has its own way to open a tab and run a command in it:
//!
//! - tmux: `tmux new-window`, in the session its client last used, whichever terminal shows it.
//! - iTerm2: AppleScript makes a tab and types the command into it.
//! - kitty: `kitty @ launch --type=tab` over its remote-control socket, when kitty.conf turns that
//!   on (`allow_remote_control` and `listen_on`); otherwise a new kitty window.
//! - WezTerm: `wezterm cli spawn`, or `wezterm start` when no WezTerm runs.
//! - Terminal, and any other: a throwaway `.command` script, which macOS opens in a new window of
//!   the terminal that opens such scripts (Terminal, unless the user changed it).
//!
//! "Automatic" picks tmux while a client is attached to it, else the terminal the user had in front
//! most recently, else the script.

use crate::comments::blocking;
use crate::git::Result;
use crate::programs;
use crate::sessions::shell_quote;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A terminal Piccolo can open agents in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Terminal {
    Tmux,
    Iterm,
    Kitty,
    Wezterm,
    /// macOS's Terminal.
    Terminal,
}

impl Terminal {
    const ALL: [Terminal; 5] = [Terminal::Tmux, Terminal::Iterm, Terminal::Kitty, Terminal::Wezterm, Terminal::Terminal];

    /// The app's name, as macOS lists running apps; tmux runs inside another terminal.
    fn app(self) -> Option<&'static str> {
        match self {
            Terminal::Tmux => None,
            Terminal::Iterm => Some("iTerm2"),
            Terminal::Kitty => Some("kitty"),
            Terminal::Wezterm => Some("WezTerm"),
            Terminal::Terminal => Some("Terminal"),
        }
    }

    fn is_installed(self) -> bool {
        match self {
            Terminal::Tmux => programs::find("tmux").is_some(),
            Terminal::Iterm => app_installed("iTerm"),
            Terminal::Kitty => kitty_binary().is_some(),
            Terminal::Wezterm => wezterm_binary().is_some(),
            Terminal::Terminal => true,
        }
    }
}

/// Where new agent sessions start: the agent's desktop app, a terminal Piccolo picks, or one the
/// user chose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Launcher {
    App,
    Auto,
    #[serde(untagged)]
    In(Terminal),
}

/// Whether macOS knows an app named `name`.
pub(crate) fn app_installed(name: &str) -> bool {
    Command::new("open")
        .args(["-Ra", name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// The program in an app bundle, or on the PATH.
fn bundled(name: &str, bundle: &str) -> Option<PathBuf> {
    programs::find(name).or_else(|| {
        let path = PathBuf::from(format!("/Applications/{bundle}.app/Contents/MacOS/{name}"));
        programs::is_executable(&path).then_some(path)
    })
}

fn kitty_binary() -> Option<PathBuf> {
    bundled("kitty", "kitty")
}

fn wezterm_binary() -> Option<PathBuf> {
    bundled("wezterm", "WezTerm")
}

/// Runs `program` with `args` and says whether it succeeded, with its error output when not.
fn run(program: &Path, args: &[&str]) -> Result<()> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Couldn't run {}: {e}", program.display()))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

// ---------------------------------------------------------------------------------------------
// Detection

/// Whether a client is attached to a tmux server: the user works in tmux right now.
fn tmux_attached() -> bool {
    let Some(tmux) = programs::find("tmux") else { return false };
    Command::new(tmux)
        .args(["list-clients", "-F", "#{client_name}"])
        .stderr(Stdio::null())
        .output()
        .is_ok_and(|o| o.status.success() && !o.stdout.trim_ascii().is_empty())
}

/// The terminal app nearest the front: macOS lists visible apps front to back.
fn frontmost_terminal() -> Option<Terminal> {
    let output = Command::new("lsappinfo").arg("visibleProcessList").output().ok()?;
    frontmost_in(&String::from_utf8_lossy(&output.stdout))
}

/// The first terminal app in `lsappinfo visibleProcessList` output: `ASN:0x0-0x1-"Name": …`.
fn frontmost_in(list: &str) -> Option<Terminal> {
    list.split("ASN:").filter_map(|entry| entry.split('"').nth(1)).find_map(|name| {
        Terminal::ALL.into_iter().find(|t| t.app() == Some(name))
    })
}

/// The terminal "Automatic" picks right now, if any; without one, the default handler opens a script.
fn detect() -> Option<Terminal> {
    if tmux_attached() {
        return Some(Terminal::Tmux);
    }
    frontmost_terminal()
}

// ---------------------------------------------------------------------------------------------
// kitty's remote control

/// kitty's remote-control socket, when kitty.conf turns remote control on and listens on a socket.
fn kitty_socket() -> Option<String> {
    let dir = std::env::var_os("KITTY_CONFIG_DIRECTORY")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config/kitty"));
    let config = std::fs::read_to_string(dir.join("kitty.conf")).ok()?;
    let (allowed, listen_on) = kitty_remote_control(&config);
    let path = listen_on?.strip_prefix("unix:")?.to_string();
    if !allowed {
        return None;
    }
    let home = dirs::home_dir().unwrap_or_default();
    let path = match path.strip_prefix("~/") {
        Some(rest) => home.join(rest).to_string_lossy().into_owned(),
        None => path,
    };
    // kitty names the socket after its process: `{kitty_pid}` in the path, or a `-<pid>` suffix.
    let pids = Command::new("pgrep").args(["-x", "kitty"]).output().ok()?;
    let pids = String::from_utf8_lossy(&pids.stdout).to_string();
    let candidates = pids.split_whitespace().flat_map(|pid| [path.replace("{kitty_pid}", pid), format!("{path}-{pid}")]);
    std::iter::once(path.clone())
        .chain(candidates)
        .find(|candidate| std::fs::symlink_metadata(candidate).is_ok_and(|m| std::os::unix::fs::FileTypeExt::is_socket(&m.file_type())))
        .map(|socket| format!("unix:{socket}"))
}

/// Whether kitty.conf allows remote control, and where it listens: the last setting of each wins.
fn kitty_remote_control(config: &str) -> (bool, Option<String>) {
    let (mut allowed, mut listen_on) = (false, None);
    for line in config.lines() {
        let mut words = line.split_whitespace();
        match (words.next(), words.next()) {
            (Some("allow_remote_control"), Some(value)) => allowed = !matches!(value, "no" | "n" | "false"),
            (Some("listen_on"), Some(value)) => listen_on = Some(value.to_string()),
            _ => {}
        }
    }
    (allowed, listen_on)
}

// ---------------------------------------------------------------------------------------------
// Opening

/// `command` run by the user's login shell, which then stays open so the tab can be used after the
/// agent exits.
fn in_shell(command: &str) -> [String; 3] {
    let shell = programs::login_shell();
    let rest = format!("{command}; exec {} -l", shell_quote(&shell));
    [shell, "-lic".into(), rest]
}

/// Runs `command` (a shell command line) in `dir`, in a new tab of `terminal` where it has tabs, or
/// in the terminal "Automatic" picks. Returns the terminal it opened in, `None` for the default one.
pub fn open(terminal: Option<Terminal>, dir: &str, command: &str) -> Result<Option<Terminal>> {
    let terminal = terminal.or_else(detect);
    match terminal {
        Some(Terminal::Tmux) => tmux(dir, command),
        Some(Terminal::Iterm) => iterm(dir, command),
        Some(Terminal::Kitty) => kitty(dir, command),
        Some(Terminal::Wezterm) => wezterm(dir, command),
        Some(Terminal::Terminal) => script(dir, command, Some("Terminal")),
        None => script(dir, command, None),
    }?;
    Ok(terminal)
}

fn tmux(dir: &str, command: &str) -> Result<()> {
    let tmux = programs::find("tmux").ok_or("tmux isn't installed")?;
    let [shell, flags, line] = in_shell(command);
    run(&tmux, &["new-window", "-c", dir, &shell, &flags, &line]).map_err(|e| format!("tmux couldn't open a window: {e}"))
}

/// Makes a tab in iTerm2's front window (or a window, when it has none) and types the command.
fn iterm(dir: &str, command: &str) -> Result<()> {
    const SCRIPT: &str = r#"on run argv
    tell application "iTerm"
        activate
        if (count of windows) is 0 then
            create window with default profile
        else
            tell current window to create tab with default profile
        end if
        tell current session of current window to write text (item 1 of argv)
    end tell
end run"#;
    let line = format!("cd {} && {command}", shell_quote(dir));
    run(Path::new("osascript"), &["-e", SCRIPT, &line]).map_err(|e| format!("iTerm2 couldn't open a tab: {e}"))
}

/// A tab over kitty's remote control when it's on, else a new kitty window.
fn kitty(dir: &str, command: &str) -> Result<()> {
    let kitty = kitty_binary().ok_or("kitty isn't installed")?;
    let [shell, flags, line] = in_shell(command);
    if let Some(socket) = kitty_socket() {
        run(&kitty, &["@", "--to", &socket, "launch", "--type=tab", "--cwd", dir, &shell, &flags, &line])
            .map_err(|e| format!("kitty couldn't open a tab: {e}"))?;
        return run(Path::new("open"), &["-a", "kitty"]);
    }
    run(Path::new("open"), &["-na", "kitty", "--args", "--directory", dir, &shell, &flags, &line])
        .map_err(|e| format!("Couldn't open kitty: {e}"))
}

/// A tab in the running WezTerm, else a new WezTerm window.
fn wezterm(dir: &str, command: &str) -> Result<()> {
    let wezterm = wezterm_binary().ok_or("WezTerm isn't installed")?;
    let [shell, flags, line] = in_shell(command);
    if run(&wezterm, &["cli", "spawn", "--cwd", dir, "--", &shell, &flags, &line]).is_ok() {
        return run(Path::new("open"), &["-a", "WezTerm"]);
    }
    Command::new(&wezterm)
        .args(["start", "--cwd", dir, "--", &shell, &flags, &line])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open WezTerm: {e}"))
}

/// A `.command` script that deletes itself and runs the command, opened in `app`, or in the
/// terminal macOS opens such scripts with.
fn script(dir: &str, command: &str, app: Option<&str>) -> Result<()> {
    let [shell, flags, line] = in_shell(command);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let path = std::env::temp_dir().join(format!("piccolo-agent-{}-{nanos}.command", std::process::id()));
    let text = format!(
        "#!/bin/sh\nrm -f -- \"$0\"\ncd {} || exit 1\nexec {} {flags} {}\n",
        shell_quote(dir),
        shell_quote(&shell),
        shell_quote(&line)
    );
    std::fs::write(&path, text).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o700)).map_err(|e| e.to_string())?;
    let path = path.to_string_lossy().into_owned();
    let args: Vec<&str> = match app {
        Some(app) => vec!["-a", app, &path],
        None => vec![&path],
    };
    run(Path::new("open"), &args).map_err(|e| format!("Couldn't open a terminal: {e}"))
}

// ---------------------------------------------------------------------------------------------
// Tauri commands

/// What Settings shows about terminals.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    /// Terminals found on this Mac, in the order Settings lists them.
    pub installed: Vec<Terminal>,
    /// The one "Automatic" would pick right now.
    pub detected: Option<Terminal>,
    /// Whether kitty opens agents in tabs (remote control on), rather than in new windows.
    pub kitty_tabs: bool,
}

#[tauri::command]
pub async fn terminal_setup() -> Result<Setup> {
    blocking(|| {
        Ok(Setup {
            installed: Terminal::ALL.into_iter().filter(|t| t.is_installed()).collect(),
            detected: detect(),
            kitty_tabs: kitty_socket().is_some(),
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_frontmost_terminal() {
        let list = r#"ASN:0x0-0x1bc5bc4-"Arc": ASN:0x0-0x10010-"Finder": ASN:0x0-0x353353-"kitty": ASN:0x0-0x2-"iTerm2": "#;
        assert_eq!(frontmost_in(list), Some(Terminal::Kitty));
        assert_eq!(frontmost_in(r#"ASN:0x0-0x1-"Arc": "#), None);
    }

    #[test]
    fn reads_kitty_remote_control_settings() {
        let config = "# allow_remote_control yes\nallow_remote_control socket-only\nlisten_on unix:/tmp/kitty\n";
        assert_eq!(kitty_remote_control(config), (true, Some("unix:/tmp/kitty".into())));
        assert_eq!(kitty_remote_control("allow_remote_control yes\nallow_remote_control no\n"), (false, None));
        assert_eq!(kitty_remote_control("font_size 13\n"), (false, None));
    }

    #[test]
    fn reads_launchers() {
        let parse = |s: &str| serde_json::from_str::<Launcher>(s).unwrap();
        assert_eq!(parse("\"app\""), Launcher::App);
        assert_eq!(parse("\"auto\""), Launcher::Auto);
        assert_eq!(parse("\"kitty\""), Launcher::In(Terminal::Kitty));
        assert!(serde_json::from_str::<Launcher>("\"hyper\"").is_err());
    }

    #[test]
    fn writes_a_script_that_runs_in_the_worktree() {
        let [shell, flags, line] = in_shell("codex 'review it'");
        assert_eq!(flags, "-lic");
        assert_eq!(line, format!("codex 'review it'; exec {} -l", shell_quote(&shell)));
    }
}
