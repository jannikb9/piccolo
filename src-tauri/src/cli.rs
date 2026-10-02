//! The `review` command: lets an agent read and answer review comments from its worktree.
//! It's the app binary itself, run with a subcommand (the app links it onto the PATH).

use crate::comments::{self, Author, ExcerptRow, LineRange, Side, Store, Target, Thread};
use crate::git::{LineKind, Result};
use std::io::Read;

const HELP: &str = "\
review — read and answer review comments on the current branch

Usage:
  review comments [--all] [--json]   Open comments on this branch (--all includes resolved ones)
  review reply <id> <message>        Reply to a comment (reads the message from stdin if omitted)
  review resolve <id>                Mark a comment resolved
  review reopen <id>                 Reopen a resolved comment

Comments are written in the Review app and belong to the branch checked out in the current folder.";

/// Runs the command line if the process was started with a subcommand; returns its exit code.
pub fn run_if_command() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first()?.as_str();
    if !matches!(command, "comments" | "reply" | "resolve" | "reopen" | "help" | "--help" | "-h") {
        return None;
    }
    Some(match run(command, &args[1..]) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("review: {e}");
            1
        }
    })
}

fn run(command: &str, args: &[String]) -> Result<()> {
    match command {
        "comments" => {
            let flag = |name: &str| args.iter().any(|a| a == name);
            if let Some(unknown) = args.iter().find(|a| !matches!(a.as_str(), "--all" | "--json")) {
                return Err(format!("unknown option {unknown}\n\n{HELP}"));
            }
            list(flag("--all"), flag("--json"))
        }
        "reply" => {
            let id = thread_id(args)?;
            let mut body = args[1..].join(" ");
            if body.is_empty() || body == "-" {
                body.clear();
                std::io::stdin().read_to_string(&mut body).map_err(|e| e.to_string())?;
            }
            Store::open()?.reply(id, Author::Agent, &body, &[])?;
            println!("Replied to #{id}.");
            Ok(())
        }
        "resolve" | "reopen" => {
            let id = thread_id(args)?;
            Store::open()?.set_resolved(id, command == "resolve")?;
            println!("{} #{id}.", if command == "resolve" { "Resolved" } else { "Reopened" });
            Ok(())
        }
        _ => {
            println!("{HELP}");
            Ok(())
        }
    }
}

fn thread_id(args: &[String]) -> Result<i64> {
    let arg = args.first().ok_or_else(|| format!("missing comment id\n\n{HELP}"))?;
    arg.trim_start_matches('#').parse().map_err(|_| format!("not a comment id: {arg}"))
}

fn list(include_resolved: bool, json: bool) -> Result<()> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let target = Target::of(&cwd).map_err(|_| "not inside a git repository".to_string())?;
    let mut threads = Store::open()?.threads(&target, include_resolved)?;
    comments::locate_in_worktree(&mut threads, std::path::Path::new(&target.worktree));
    if json {
        println!("{}", serde_json::to_string_pretty(&threads).map_err(|e| e.to_string())?);
    } else {
        print!("{}", format_threads(&target, &threads, include_resolved));
    }
    Ok(())
}

/// Markdown for an agent: each thread with the code it's about, then how to answer.
fn format_threads(target: &Target, threads: &[Thread], include_resolved: bool) -> String {
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
        if thread.resolved {
            out.push_str(" (resolved)");
        }
        out.push_str("\n\n");
        out.push_str(&format_excerpt(&thread.excerpt));
        for message in &thread.messages {
            let who = match message.author {
                Author::Reviewer => "Reviewer",
                Author::Agent => "Agent",
            };
            let body = message.body.trim();
            let gap = if body.is_empty() { "" } else { " " };
            out.push_str(&format!("\n**{who}:**{gap}{body}\n"));
            for image in &message.attachments {
                out.push_str(&format!("Attached image ({}×{}): {}\n", image.width, image.height, image.path));
            }
        }
    }
    out.push_str(
        "\n---\nAfter addressing a comment, reply with what you changed: `review reply <id> \"<message>\"`\n",
    );
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
    let path = &thread.path;
    match &thread.position {
        None => format!("{path} (outdated: the code changed since this comment on {})", describe(&thread.range)),
        Some(p) if p.start_side == Side::Additions && p.end_side == Side::Additions => {
            let moved = if *p != thread.range {
                format!(" (was {} when commented)", lines(thread.range.start_line, thread.range.end_line))
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
        assert_eq!(format_threads(&target, &[], false), "No open review comments on feat/x in /wt/feat.\n");
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
    fn lists_attached_images_with_their_paths() {
        use crate::comments::tests::{additions, fixture};
        use crate::comments::{NewImage, NewThread};
        use crate::git::{DiffRange, Scope};

        let (root, wt, mut store) = fixture("cli-images");
        let target = Target::of(&wt).unwrap();
        let range = DiffRange::resolve(&wt, Some("main"), &Scope::All).unwrap();
        let image = NewImage { width: 640, height: 480, data: b"\x89PNG\r\n\x1a\nx".to_vec() };
        let new = NewThread { path: "a.txt", old_path: None, range: additions(3, 3), body: "Looks off:", images: &[image] };
        let id = store.add_thread(&target, &wt, &range, new).unwrap();
        let only_image = NewImage { width: 10, height: 20, data: b"\x89PNG\r\n\x1a\ny".to_vec() };
        store.reply(id, Author::Reviewer, "", &[only_image]).unwrap();

        let threads = store.threads(&target, false).unwrap();
        let out = format_threads(&target, &threads, false);
        let path = |n: usize| threads[0].messages[n].attachments[0].path.clone();
        assert!(out.contains(&format!("**Reviewer:** Looks off:\nAttached image (640×480): {}\n", path(0))), "{out}");
        assert!(out.contains(&format!("**Reviewer:**\nAttached image (10×20): {}\n", path(1))), "{out}");

        fs::remove_dir_all(&root).unwrap();
    }
}
