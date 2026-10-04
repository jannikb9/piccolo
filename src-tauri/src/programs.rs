//! Finding the user's command-line programs. An app opened from the Finder gets a minimal PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), while agents' CLIs live wherever the user's shell setup puts
//! them (`~/.local/bin`, Homebrew, a Node version manager), so the PATH is read from the user's
//! login shell once and kept.

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

/// Marks the PATH in the shell's output, which startup files may add to.
const MARKER: &str = "__PICCOLO_PATH__";
/// A shell whose startup takes longer than this is given up on.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

/// The folders to look for programs in: the login shell's PATH, then this process's, then the
/// usual install folders.
pub fn search_path() -> &'static [PathBuf] {
    static PATH: OnceLock<Vec<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        let home = dirs::home_dir().unwrap_or_default();
        let mut dirs = login_shell_path().unwrap_or_default();
        dirs.extend(std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default());
        dirs.extend([home.join(".local/bin"), PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
        let mut seen = std::collections::HashSet::new();
        dirs.retain(|d| seen.insert(d.clone()));
        dirs
    })
}

/// [`search_path`] as a `PATH` value, for programs Piccolo starts.
pub fn path_variable() -> std::ffi::OsString {
    std::env::join_paths(search_path()).unwrap_or_default()
}

/// The program `name` in [`search_path`].
pub fn find(name: &str) -> Option<PathBuf> {
    search_path().iter().map(|dir| dir.join(name)).find(|p| is_executable(p))
}

pub fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The PATH the user's login shell sets up, interactive so that `.zshrc` and the like are read.
fn login_shell_path() -> Option<Vec<PathBuf>> {
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", &format!("printf '{MARKER}%s{MARKER}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (done, output) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        let _ = done.send(text);
    });
    let text = output.recv_timeout(SHELL_TIMEOUT);
    let _ = child.kill();
    let _ = child.wait();
    parse_marked_path(&text.ok()?)
}

fn parse_marked_path(output: &str) -> Option<Vec<PathBuf>> {
    let (_, rest) = output.split_once(MARKER)?;
    let (path, _) = rest.split_once(MARKER)?;
    let dirs: Vec<PathBuf> = std::env::split_paths(path).filter(|d| d.is_absolute()).collect();
    (!dirs.is_empty()).then_some(dirs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_path_between_markers() {
        let output = format!("Welcome!\n{MARKER}/a/bin:/usr/bin:relative{MARKER}");
        assert_eq!(parse_marked_path(&output), Some(vec![PathBuf::from("/a/bin"), PathBuf::from("/usr/bin")]));
        assert_eq!(parse_marked_path("no markers"), None);
        assert!(find("sh").is_some_and(|p| p.ends_with("sh")));
        assert!(find("surely-not-a-program-piccolo").is_none());
    }
}
