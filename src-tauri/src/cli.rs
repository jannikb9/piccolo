//! The `piccolo` command: lets an agent read, answer and write review comments from its worktree.
//! It's the app binary itself, run with a subcommand (the app links it onto the PATH).

use crate::comments::{self, Author, By, ExcerptRow, LineRange, NewThread, Side, Store, Target, Thread};
use crate::git::{self, DiffOptions, DiffRange, LineKind, Result, Scope};
use crate::repos;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const HELP: &str = "\
piccolo — read, answer and write review comments on the current branch

Usage:
  piccolo comments [<id>...] [--all] [--json]
                                     Open comments on this branch (--all includes resolved ones),
                                     or only the ones whose ids are given
  piccolo reply <id> <message>       Reply to a comment
  piccolo comment <file>:<line>[-<end>] [--removed] <message>
                                     Comment on lines of a file as it is now (--removed: lines the
                                     branch removed, numbered as in the base version)
  piccolo comment --general <message>
                                     Comment on the branch as a whole, not on particular lines
  piccolo submit <summary>           Finish reviewing the branch: posts the summary as a general
                                     comment and tells the developer the review is done
  piccolo resolve <id>               Mark a comment resolved
  piccolo reopen <id>                Reopen a resolved comment
  piccolo guide                      How to review this branch as an agent

Every command works on the worktree in the current folder, or the one `-C <worktree>` names: a
path, or a branch or worktree folder name in a repository added to the app. File paths are then
relative to that worktree.

A message of `-` (or none) is read from stdin. `--as <name>` signs a reply, comment or review with
the agent's name (e.g. codex); without it, PICCOLO_AUTHOR is used, or `claude` inside Claude Code.

Comments are shown in Piccolo and belong to the branch checked out in the current folder.";

/// Runs the command line if the process was started with a subcommand; returns its exit code.
pub fn run_if_command() -> Option<i32> {
    let (worktree, args) = take_worktree_option(std::env::args().skip(1).collect());
    let command = args.first().map(String::as_str).unwrap_or_default();
    if !matches!(command, "comments" | "reply" | "comment" | "submit" | "resolve" | "reopen" | "guide" | "help" | "--help" | "-h") {
        // `-C` only belongs to the command line; without a command it's the app being launched.
        worktree.as_ref()?;
        eprintln!("piccolo: missing command\n\n{HELP}");
        return Some(1);
    }
    let result = Folder::resolve(worktree.as_deref()).and_then(|folder| {
        note_session(&folder);
        run(command, &args[1..], &folder)
    });
    Some(match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("piccolo: {e}");
            1
        }
    })
}

/// Run inside a Claude Code session, records that the session works on this worktree, so the
/// app offers it comments for the worktree even when it runs in a folder above it. Best effort:
/// the command itself doesn't depend on it.
fn note_session(folder: &Folder) {
    let Some(session) = std::env::var("CLAUDE_CODE_SESSION_ID").ok().filter(|id| !id.trim().is_empty()) else { return };
    if let (Ok(target), Ok(store)) = (folder.target(), Store::open()) {
        let _ = store.note_session(&session, &target.worktree);
    }
}

/// Removes `-C <worktree>` from anywhere in the arguments.
fn take_worktree_option(args: Vec<String>) -> (Option<String>, Vec<String>) {
    let mut worktree = None;
    let mut rest = Vec::new();
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg == "-C" {
            worktree = iter.next();
        } else {
            rest.push(arg);
        }
    }
    (worktree, rest)
}

/// The folder a command works in: the current one, or the worktree `-C` names.
struct Folder {
    path: PathBuf,
    /// Named with `-C`, so commands suggested to the agent name it too.
    explicit: bool,
}

impl Folder {
    fn resolve(worktree: Option<&str>) -> Result<Self> {
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        match worktree {
            None => Ok(Self { path: cwd, explicit: false }),
            Some(name) => Ok(Self { path: find_worktree(&cwd, name, &repos::saved_paths())?, explicit: true }),
        }
    }

    fn target(&self) -> Result<Target> {
        Target::of(&self.path).map_err(|_| format!("{} isn't inside a git repository", self.path.display()))
    }

    /// How a suggested `piccolo` command names this folder: ` -C <worktree>`, or nothing.
    fn option(&self, target: &Target) -> String {
        if self.explicit { format!(" -C {}", shell_quote(&target.worktree)) } else { String::new() }
    }
}

/// `name` as a folder (relative to `cwd`, or absolute), else the worktree of one of `repos` whose
/// branch or folder is called `name`.
fn find_worktree(cwd: &Path, name: &str, repos: &[String]) -> Result<PathBuf> {
    let folder = cwd.join(name);
    if folder.is_dir() {
        return Ok(folder);
    }
    let mut found: Vec<String> = Vec::new();
    for repo in repos {
        for entry in git::list_worktrees(Path::new(repo)).unwrap_or_default() {
            let folder_name = Path::new(&entry.path).file_name().map(|n| n.to_string_lossy().into_owned());
            if !entry.bare && (entry.branch.as_deref() == Some(name) || folder_name.as_deref() == Some(name)) {
                found.push(entry.path);
            }
        }
    }
    found.dedup();
    match found.len() {
        1 => Ok(PathBuf::from(found.remove(0))),
        0 => Err(format!(
            "no folder or worktree called {name}: it isn't a path, nor a branch in a repository added to Piccolo"
        )),
        _ => Err(format!("{name} is in several repositories; pass one of these paths with -C:\n  {}", found.join("\n  "))),
    }
}

/// `value` as one shell word.
fn shell_quote(value: &str) -> String {
    if !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || "/._-~+=:@".contains(c)) {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn run(command: &str, args: &[String], folder: &Folder) -> Result<()> {
    match command {
        "comments" => {
            let args = Args::parse(args, &["--all", "--json"])?;
            let only = args.positional.iter().map(|id| thread_id(std::slice::from_ref(id))).collect::<Result<Vec<_>>>()?;
            list(folder, &only, args.has("--all"), args.has("--json"))
        }
        "reply" => {
            let args = Args::parse(args, &["--as"])?;
            let id = thread_id(&args.positional)?;
            let body = message(&args.positional[1..])?;
            let name = agent_name(args.name)?;
            Store::open()?.reply(id, By { author: Author::Agent, name: name.as_deref() }, &body, &[])?;
            println!("Replied to #{id}.");
            Ok(())
        }
        "comment" => {
            let args = Args::parse(args, &["--as", "--removed", "--general"])?;
            let name = agent_name(args.name.clone())?;
            let by = By { author: Author::Agent, name: name.as_deref() };
            if args.has("--general") {
                if args.has("--removed") {
                    return Err("a general comment isn't on lines, so it can't be on removed ones".into());
                }
                let body = message(&args.positional)?;
                let target = folder.target()?;
                let id = Store::open()?.add_general_thread(&target, by, &body, &[])?;
                println!("Commented on {} (#{id}).", target.label());
                return Ok(());
            }
            let location = args.positional.first().ok_or_else(|| format!("missing <file>:<line>\n\n{HELP}"))?;
            let body = message(&args.positional[1..])?;
            let side = if args.has("--removed") { Side::Deletions } else { Side::Additions };
            println!("{}", add_comment(&mut Store::open()?, &folder.path, location, side, &body, by)?);
            Ok(())
        }
        "submit" => {
            let args = Args::parse(args, &["--as"])?;
            let name = agent_name(args.name)?.ok_or("say who reviewed: --as <your name>")?;
            let summary = message(&args.positional)?;
            let target = folder.target()?;
            let review = Store::open()?.submit_review(&target, &name, &summary)?;
            let comments = match review.comments {
                0 => "no comments".to_string(),
                1 => "1 comment".to_string(),
                n => format!("{n} comments"),
            };
            println!("Submitted your review of {} with {comments}; the summary is #{}.", target.label(), review.thread);
            Ok(())
        }
        "resolve" | "reopen" => {
            let id = thread_id(args)?;
            Store::open()?.set_resolved(id, command == "resolve")?;
            println!("{} #{id}.", if command == "resolve" { "Resolved" } else { "Reopened" });
            Ok(())
        }
        "guide" => {
            let target = folder.target()?;
            print!("{}", guide(&target, &folder.option(&target))?);
            Ok(())
        }
        _ => {
            println!("{HELP}");
            Ok(())
        }
    }
}

/// A command's arguments: the options it takes, and the rest in order.
struct Args {
    positional: Vec<String>,
    flags: Vec<String>,
    /// The value of `--as`.
    name: Option<String>,
}

impl Args {
    fn parse(args: &[String], allowed: &[&str]) -> Result<Self> {
        let mut parsed = Self { positional: Vec::new(), flags: Vec::new(), name: None };
        let mut iter = args.iter();
        while let Some(arg) = iter.next() {
            if arg.starts_with("--") && arg.len() > 2 {
                if !allowed.contains(&arg.as_str()) {
                    return Err(format!("unknown option {arg}\n\n{HELP}"));
                }
                if arg == "--as" {
                    parsed.name = Some(iter.next().ok_or("--as needs a name")?.clone());
                } else {
                    parsed.flags.push(arg.clone());
                }
            } else {
                parsed.positional.push(arg.clone());
            }
        }
        Ok(parsed)
    }

    fn has(&self, flag: &str) -> bool {
        self.flags.iter().any(|f| f == flag)
    }

}

fn thread_id(args: &[String]) -> Result<i64> {
    let arg = args.first().ok_or_else(|| format!("missing comment id\n\n{HELP}"))?;
    arg.trim_start_matches('#').parse().map_err(|_| format!("not a comment id: {arg}"))
}

/// The message given after the other arguments, or read from stdin when it's `-` or missing.
fn message(words: &[String]) -> Result<String> {
    let mut body = words.join(" ");
    if body.is_empty() || body == "-" {
        body.clear();
        std::io::stdin().read_to_string(&mut body).map_err(|e| e.to_string())?;
    }
    Ok(body)
}

/// The agent's name: `--as`, else `PICCOLO_AUTHOR`, else `claude` when run by Claude Code.
fn agent_name(given: Option<String>) -> Result<Option<String>> {
    let name = given
        .or_else(|| std::env::var("PICCOLO_AUTHOR").ok().filter(|n| !n.trim().is_empty()))
        .or_else(|| std::env::var_os("CLAUDECODE").map(|_| "claude".to_string()));
    let Some(name) = name else { return Ok(None) };
    let name = name.trim().to_lowercase();
    let valid = (1..=32).contains(&name.len())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !valid {
        return Err(format!("not a usable name: {name} (letters, digits, - _ . and at most 32 characters)"));
    }
    Ok(Some(name))
}

/// How a message's author is shown: `Reviewer`, or the agent's name (`Codex`), or `Agent`.
fn author_label(author: Author, name: Option<&str>) -> String {
    match (author, name) {
        (Author::Reviewer, _) => "Reviewer".into(),
        (Author::Agent, Some(name)) => {
            let mut chars = name.chars();
            chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
        }
        (Author::Agent, None) => "Agent".into(),
    }
}

fn list(folder: &Folder, only: &[i64], include_resolved: bool, json: bool) -> Result<()> {
    let target = folder.target()?;
    let mut threads = Store::open()?.threads(&target, include_resolved || !only.is_empty())?;
    if !only.is_empty() {
        threads.retain(|t| only.contains(&t.id));
    }
    comments::locate_in_worktree(&mut threads, Path::new(&target.worktree));
    if json {
        println!("{}", serde_json::to_string_pretty(&threads).map_err(|e| e.to_string())?);
    } else {
        print!("{}", format_threads(&target, &threads, include_resolved, &folder.option(&target)));
    }
    Ok(())
}

/// Starts a thread on `<file>:<line>[-<end>]`, against the same diff the app shows by default:
/// everything since the branch forked from its base, uncommitted work included.
fn add_comment(store: &mut Store, cwd: &Path, location: &str, side: Side, body: &str, by: By) -> Result<String> {
    let (file, lines) = location
        .rsplit_once(':')
        .ok_or_else(|| format!("expected <file>:<line> or <file>:<start>-<end>, not {location}"))?;
    let (start, end) = parse_lines(lines).ok_or_else(|| format!("not a line or line range: {lines}"))?;
    let target = Target::of(cwd).map_err(|_| format!("{} isn't inside a git repository", cwd.display()))?;
    let wt = Path::new(&target.worktree);
    let path = worktree_path(wt, cwd, file)?;

    let base = git::default_branch(Path::new(&target.repo));
    let range = DiffRange::resolve(wt, base.as_deref(), &Scope::All)?;
    let old_path = git::changed_files(wt, base.as_deref(), Scope::All, DiffOptions::default())?
        .into_iter()
        .find(|f| f.path == path)
        .and_then(|f| f.old_path);
    let new = NewThread {
        by,
        path: &path,
        old_path: old_path.as_deref(),
        range: LineRange { start_side: side, start_line: start, end_side: side, end_line: end },
        body,
        images: &[],
    };
    let id = store.add_thread(&target, wt, &range, new)?;
    Ok(format!("Commented on {path}:{} (#{id}).", self::lines(start, end)))
}

/// `12` or `12-14`, top line first.
fn parse_lines(lines: &str) -> Option<(u32, u32)> {
    let (a, b) = lines.split_once('-').unwrap_or((lines, lines));
    let (a, b): (u32, u32) = (a.trim().parse().ok()?, b.trim().parse().ok()?);
    (a > 0 && b > 0).then(|| (a.min(b), a.max(b)))
}

/// `file` (relative to `cwd`, or absolute) as a path relative to the worktree, as git names it.
/// Works for files that no longer exist, which removed lines are on.
fn worktree_path(wt: &Path, cwd: &Path, file: &str) -> Result<String> {
    let outside = || format!("{file} isn't inside the worktree {}", wt.display());
    let relative: PathBuf = if Path::new(file).is_absolute() {
        let file = Path::new(file);
        match file.strip_prefix(wt) {
            Ok(rest) => rest.to_path_buf(),
            // The worktree path is canonical; the file's may go through a symlink (/tmp).
            Err(_) => file.canonicalize().ok().and_then(|f| f.strip_prefix(wt).ok().map(Path::to_path_buf)).ok_or_else(outside)?,
        }
    } else {
        let prefix = git::git(cwd, &["rev-parse", "--show-prefix"])?;
        Path::new(prefix.trim()).join(file)
    };
    let mut parts: Vec<String> = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::ParentDir => {
                parts.pop().ok_or_else(outside)?;
            }
            Component::CurDir => {}
            _ => return Err(outside()),
        }
    }
    if parts.is_empty() {
        return Err(format!("{file} is a folder, not a file"));
    }
    Ok(parts.join("/"))
}

/// Instructions for an agent reviewing the branch, with this branch's base and commands filled in.
/// `via` is how suggested commands name the worktree (` -C <worktree>`), or empty in it.
fn guide(target: &Target, via: &str) -> Result<String> {
    let wt = Path::new(&target.worktree);
    let git = if via.is_empty() { "git".to_string() } else { format!("git -C {}", shell_quote(&target.worktree)) };
    let relative_to = if via.is_empty() { "the current folder" } else { "the worktree" };
    let branch = target.label();
    let base = git::default_branch(Path::new(&target.repo));
    let (compared, diff) = match &base {
        Some(base) => {
            let fork = git::merge_base(wt, base)?;
            (
                format!("compared with {base}, from where it branched off ({})", &fork[..fork.len().min(10)]),
                format!("{git} diff {fork}"),
            )
        }
        None => ("with no base branch found, so only its uncommitted changes".to_string(), format!("{git} diff HEAD")),
    };
    Ok(format!(
        "\
# Reviewing {branch}

You're reviewing the changes on {branch} in {worktree}, {compared}. Your comments appear in Piccolo next to the diff, where the developer reads them and other agents pick them up. Don't change any files: review only.

1. See what changed: `{diff}` shows everything, uncommitted work included, and `{git} status --short` lists new files as untracked (??); read those whole. Read the surrounding code where the diff alone doesn't tell you enough.
2. Read what's been said already: `piccolo{via} comments --all`. Don't raise a point again, whether it's open, resolved or dismissed (the developer decided that one needs no action); to add to a thread, `piccolo{via} reply --as <your name> <id> \"...\"`.
3. Comment on the lines each issue is about. Paths are relative to {relative_to}, and line numbers are those of the file as it is now:
   - `piccolo{via} comment --as <your name> <file>:<line> \"...\"`
   - `piccolo{via} comment --as <your name> <file>:<start>-<end> \"...\"`
   - `piccolo{via} comment --as <your name> --removed <file>:<line> \"...\"` for lines the branch removed, numbered as in the old version
   - `piccolo{via} comment --as <your name> --general \"...\"` for a point about the change as a whole rather than particular lines: the approach, something missing, how the parts fit together
   For a long message, pass `-` instead and write it to stdin.
4. What's worth a comment: bugs, missed cases, risky or surprising behaviour, unclear names or structure, tests that don't check what they claim. One issue per comment: say what's wrong and why, and suggest a fix. No praise, and no nits a formatter or linter would catch.
5. Submit your review: `piccolo{via} submit --as <your name> \"...\"` with a short summary: your verdict and the most important points, without repeating every comment. It's posted as a general comment and tells the developer you're done, so submit once, at the end, even when you found nothing to comment on.
6. Finish with one line in the chat: how many comments you left, and the most important one.

Sign everything with `--as` and your name (e.g. `--as codex`), so the developer sees who wrote what.
",
        worktree = target.worktree,
    ))
}

/// Markdown for an agent: each thread with the code it's about, then how to answer.
/// `via` is how the suggested reply command names the worktree (` -C <worktree>`), or empty.
fn format_threads(target: &Target, threads: &[Thread], include_resolved: bool, via: &str) -> String {
    let (branch, worktree) = (target.label(), &target.worktree);
    let what = if include_resolved { "review comments" } else { "open review comments" };
    if threads.is_empty() {
        return format!("No {what} on {branch} in {worktree}.\n");
    }
    // Agents often work from outside the worktree, so say where the relative paths start.
    let mut out = format!("# Review comments on {branch}\n\nWorktree: {worktree} (file paths below are relative to it)\n\n");
    let count = threads.len();
    out.push_str(&format!(
        "{count} {}. Line numbers refer to the files as they are now; the code shown is what the reviewer saw.\n",
        if count == 1 { what.trim_end_matches('s').to_string() } else { what.to_string() },
    ));
    for thread in threads {
        out.push_str(&format!("\n## #{} · {}", thread.id, location(thread)));
        if thread.dismissed {
            out.push_str(" (dismissed: the reviewer decided it needs no action; don't raise it again)");
        } else if thread.resolved {
            out.push_str(" (resolved)");
        }
        out.push('\n');
        // General comments have no code to show.
        if !thread.excerpt.is_empty() {
            out.push('\n');
            out.push_str(&format_excerpt(&thread.excerpt));
        }
        for message in &thread.messages {
            let who = author_label(message.author, message.author_name.as_deref());
            let body = message.body.trim();
            let gap = if body.is_empty() { "" } else { " " };
            let edited = if message.edited_at.is_some() { " (edited)" } else { "" };
            out.push_str(&format!("\n**{who}{edited}:**{gap}{body}\n"));
            if message.thumbs_up {
                out.push_str("The reviewer gave this a thumbs up.\n");
            }
            for image in &message.attachments {
                out.push_str(&format!("Attached image ({}×{}): {}\n", image.width, image.height, image.path));
            }
        }
    }
    out.push_str(&format!(
        "\n---\nAfter addressing a comment, reply with what you changed: `piccolo{via} reply <id> \"<message>\"`\n"
    ));
    out
}

fn lines(start: u32, end: u32) -> String {
    if start == end {
        format!("{start}")
    } else {
        format!("{start}-{end}")
    }
}

fn describe(range: &LineRange) -> String {
    let (start, end) = (range.start_line, range.end_line);
    let side = |s: Side| if s == Side::Deletions { "removed" } else { "new" };
    if range.start_side != range.end_side {
        return format!("{} line {start} to {} line {end}", side(range.start_side), side(range.end_side));
    }
    let prefix = if range.start_side == Side::Deletions { "removed " } else { "" };
    let noun = if start == end { "line" } else { "lines" };
    format!("{prefix}{noun} {}", lines(start, end))
}

fn location(thread: &Thread) -> String {
    let (Some(path), Some(range)) = (&thread.path, thread.range) else {
        return "General comment (on the branch as a whole)".into();
    };
    match &thread.position {
        None => format!("{path} (outdated: the code changed since this comment on {})", describe(&range)),
        Some(p) if p.start_side == Side::Additions && p.end_side == Side::Additions => {
            let moved = if *p != range {
                format!(" (was {} when commented)", lines(range.start_line, range.end_line))
            } else {
                String::new()
            };
            format!("{path}:{}{moved}", lines(p.start_line, p.end_line))
        }
        Some(p) => format!("{path}, {}", describe(p)),
    }
}

/// The snapshot as numbered diff lines; commented lines are marked with `>`.
fn format_excerpt(rows: &[ExcerptRow]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let fence = if rows.iter().any(|r| r.text.contains("```")) { "````" } else { "```" };
    let width = rows.iter().filter_map(|r| r.new.max(r.old)).max().unwrap_or(0).to_string().len();
    let mut out = format!("{fence}\n");
    for row in rows {
        let (sign, number) = match row.kind {
            LineKind::Add => ('+', row.new),
            LineKind::Del => ('-', row.old),
            LineKind::Context => (' ', row.new),
        };
        let marker = if row.commented { '>' } else { ' ' };
        let number = number.map(|n| n.to_string()).unwrap_or_default();
        out.push_str(format!("{marker} {sign} {number:>width$} │ {}", row.text).trim_end());
        out.push('\n');
    }
    out.push_str(fence);
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn describes_ranges() {
        let r = |ss, s, es, e| LineRange { start_side: ss, start_line: s, end_side: es, end_line: e };
        assert_eq!(describe(&r(Side::Additions, 4, Side::Additions, 4)), "line 4");
        assert_eq!(describe(&r(Side::Additions, 4, Side::Additions, 6)), "lines 4-6");
        assert_eq!(describe(&r(Side::Deletions, 4, Side::Deletions, 4)), "removed line 4");
        assert_eq!(describe(&r(Side::Deletions, 3, Side::Additions, 5)), "removed line 3 to new line 5");
    }

    #[test]
    fn names_the_worktree() {
        let target = Target { repo: "/r".into(), branch: Some("feat/x".into()), worktree: "/wt/feat".into() };
        assert_eq!(format_threads(&target, &[], false, ""), "No open review comments on feat/x in /wt/feat.\n");
    }

    #[test]
    fn formats_excerpts() {
        let row = |kind, old, new, text: &str, commented| ExcerptRow { kind, old, new, text: text.into(), commented };
        let out = format_excerpt(&[
            row(LineKind::Context, Some(9), Some(9), "  a", false),
            row(LineKind::Del, Some(10), None, "  b", true),
            row(LineKind::Add, None, Some(10), "  c", true),
        ]);
        assert_eq!(out, "```\n     9 │   a\n> - 10 │   b\n> + 10 │   c\n```\n");
    }

    #[test]
    fn parses_line_ranges_and_names() {
        assert_eq!(parse_lines("12"), Some((12, 12)));
        assert_eq!(parse_lines("14-12"), Some((12, 14)));
        assert_eq!(parse_lines("0"), None);
        assert_eq!(parse_lines("a-3"), None);
        assert_eq!(agent_name(Some(" Codex ".into())).unwrap().as_deref(), Some("codex"));
        assert!(agent_name(Some("two words".into())).is_err());
        assert_eq!(author_label(Author::Agent, Some("codex")), "Codex");
        assert_eq!(author_label(Author::Agent, None), "Agent");
        assert_eq!(author_label(Author::Reviewer, None), "Reviewer");
    }

    #[test]
    fn agents_comment_on_lines_of_the_branch() {
        use crate::comments::tests::fixture;

        let (root, wt, mut store) = fixture("cli-comment");
        fs::create_dir_all(wt.join("src")).unwrap();
        fs::write(wt.join("src/new.rs"), "fn a() {}\nfn b() {}\n").unwrap();
        let comment = |store: &mut Store, cwd: &Path, location: &str, side: Side| {
            add_comment(store, cwd, location, side, "Why?", By { author: Author::Agent, name: Some("codex") })
        };

        // Changed, unchanged and untracked lines, with paths relative to the current folder.
        assert_eq!(comment(&mut store, &wt, "a.txt:3-4", Side::Additions).unwrap(), "Commented on a.txt:3-4 (#1).");
        comment(&mut store, &wt, "a.txt:6", Side::Additions).unwrap();
        comment(&mut store, &wt.join("src"), "new.rs:2", Side::Additions).unwrap();
        comment(&mut store, &wt.join("src"), "../a.txt:3", Side::Deletions).unwrap();

        let threads = store.threads(&Target::of(&wt).unwrap(), false).unwrap();
        let summary: Vec<_> = threads
            .iter()
            .map(|t| {
                let range = t.range.unwrap();
                (t.path.as_deref().unwrap(), range.start_side, range.start_line, range.end_line)
            })
            .collect();
        assert_eq!(
            summary,
            [("a.txt", Side::Deletions, 3, 3), ("a.txt", Side::Additions, 3, 4), ("a.txt", Side::Additions, 6, 6), ("src/new.rs", Side::Additions, 2, 2)]
        );
        let first = &threads[1].messages[0];
        assert_eq!((first.author, first.author_name.as_deref(), first.body.as_str()), (Author::Agent, Some("codex"), "Why?"));
        let out = format_threads(&Target::of(&wt).unwrap(), &threads, false, "");
        assert!(out.contains("**Codex:** Why?"), "{out}");

        // Lines that aren't there, and paths outside the worktree.
        let error = comment(&mut store, &wt, "a.txt:40", Side::Additions).unwrap_err();
        assert_eq!(error, "a.txt has no line 40 (any more)");
        assert!(comment(&mut store, &wt, "../elsewhere.txt:1", Side::Additions).unwrap_err().contains("isn't inside the worktree"));
        assert!(comment(&mut store, &wt, "a.txt", Side::Additions).is_err());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn lists_general_comments_first() {
        use crate::comments::tests::fixture;

        let (root, wt, mut store) = fixture("cli-general");
        let target = Target::of(&wt).unwrap();
        add_comment(&mut store, &wt, "a.txt:3", Side::Additions, "Why?", By::REVIEWER).unwrap();
        let codex = By { author: Author::Agent, name: Some("codex") };
        let id = store.add_general_thread(&target, codex, "The parser and the UI change belong in separate PRs.", &[]).unwrap();

        let threads = store.threads(&target, false).unwrap();
        let out = format_threads(&target, &threads, false, "");
        let expected = format!(
            "\n## #{id} · General comment (on the branch as a whole)\n\n**Codex:** The parser and the UI change belong in separate PRs.\n\n## #"
        );
        assert!(out.contains(&expected), "{out}");
        assert!(out.contains("· a.txt:3\n\n```\n"), "{out}");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn guides_reviewers_with_the_branch_base() {
        use crate::comments::tests::fixture;

        let (root, wt, _) = fixture("cli-guide");
        let target = Target::of(&wt).unwrap();
        let in_worktree = guide(&target, "").unwrap();
        assert!(in_worktree.starts_with("# Reviewing feat/x\n"), "{in_worktree}");
        assert!(in_worktree.contains("compared with main, from where it branched off"), "{in_worktree}");
        assert!(in_worktree.contains("`piccolo comment --as <your name> <file>:<line>"), "{in_worktree}");
        assert!(in_worktree.contains("`git status --short`"), "{in_worktree}");
        assert!(in_worktree.contains("`piccolo comment --as <your name> --general"), "{in_worktree}");
        assert!(in_worktree.contains("`piccolo submit --as <your name> \"...\"`"), "{in_worktree}");

        // Named from elsewhere, every suggested command names the worktree.
        let via = format!(" -C {}", shell_quote(&target.worktree));
        let from_elsewhere = guide(&target, &via).unwrap();
        assert!(from_elsewhere.contains(&format!("`piccolo{via} comment --as <your name> <file>:<line>")), "{from_elsewhere}");
        assert!(from_elsewhere.contains(&format!("`git{via} status --short`")), "{from_elsewhere}");
        assert!(from_elsewhere.contains("relative to the worktree"), "{from_elsewhere}");
        assert!(from_elsewhere.contains(&format!("`piccolo{via} submit --as <your name>")), "{from_elsewhere}");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn finds_worktrees_by_path_branch_or_folder() {
        use crate::comments::tests::fixture;

        let (root, wt, _) = fixture("cli-find");
        let repos = vec![root.join("repo").to_string_lossy().into_owned()];
        let canonical = |p: PathBuf| p.canonicalize().unwrap();
        assert_eq!(canonical(find_worktree(&root, "feat", &repos).unwrap()), canonical(wt.clone()));
        assert_eq!(canonical(find_worktree(Path::new("/"), "feat/x", &repos).unwrap()), canonical(wt.clone()));
        assert_eq!(canonical(find_worktree(Path::new("/"), "main", &repos).unwrap()), canonical(root.join("repo")));
        assert!(find_worktree(Path::new("/"), "nope", &repos).unwrap_err().contains("no folder or worktree called nope"));

        // The same branch name in two repositories needs a path.
        let other = root.join("other");
        fs::create_dir_all(&other).unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&other).output().unwrap().status.success());
        git(&["init", "-q", "-b", "main"]);
        git(&["-c", "user.name=T", "-c", "user.email=t@e.st", "commit", "-q", "--allow-empty", "-m", "init"]);
        let repos = [repos[0].clone(), other.to_string_lossy().into_owned()];
        assert!(find_worktree(Path::new("/"), "main", &repos).unwrap_err().contains("in several repositories"));

        assert_eq!(take_worktree_option(vec!["guide".into(), "-C".into(), "x".into()]), (Some("x".into()), vec!["guide".into()]));
        assert_eq!(shell_quote("/a/b.c"), "/a/b.c");
        assert_eq!(shell_quote("/a b/it's"), "'/a b/it'\\''s'");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn lists_attached_images_with_their_paths() {
        use crate::comments::tests::{additions, fixture};
        use crate::comments::{NewImage, NewThread};
        use crate::git::{DiffRange, Scope};

        let (root, wt, mut store) = fixture("cli-images");
        let target = Target::of(&wt).unwrap();
        let range = DiffRange::resolve(&wt, Some("main"), &Scope::All).unwrap();
        let image = NewImage { width: 640, height: 480, data: b"\x89PNG\r\n\x1a\nx".to_vec() };
        let new = NewThread { by: By::REVIEWER, path: "a.txt", old_path: None, range: additions(3, 3), body: "Looks off:", images: &[image] };
        let id = store.add_thread(&target, &wt, &range, new).unwrap();
        let only_image = NewImage { width: 10, height: 20, data: b"\x89PNG\r\n\x1a\ny".to_vec() };
        store.reply(id, By::REVIEWER, "", &[only_image]).unwrap();

        let threads = store.threads(&target, false).unwrap();
        let out = format_threads(&target, &threads, false, "");
        let path = |n: usize| threads[0].messages[n].attachments[0].path.clone();
        assert!(out.contains(&format!("**Reviewer:** Looks off:\nAttached image (640×480): {}\n", path(0))), "{out}");
        assert!(out.contains(&format!("**Reviewer:**\nAttached image (10×20): {}\n", path(1))), "{out}");

        fs::remove_dir_all(&root).unwrap();
    }
}
