//! The GitHub pull requests of worktrees' branches, read with the GitHub CLI (`gh`) and the account
//! it's signed in to: one request per repository. Without `gh` there are none.

use crate::git::Result;
use crate::programs;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub state: PullState,
    pub url: String,
    /// Not ready for review yet.
    pub draft: bool,
    /// Approved by its reviewers, and no one's latest review asks for changes.
    pub approved: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all(serialize = "lowercase", deserialize = "UPPERCASE"))]
pub enum PullState {
    Open,
    Closed,
    Merged,
}

/// The newest pull request of each of `branches` in the GitHub repository at `repo`, by branch;
/// branches without one are left out.
#[tauri::command]
pub async fn pull_requests(repo: String, branches: Vec<String>) -> Result<HashMap<String, PullRequest>> {
    crate::repos::blocking(move || find(Path::new(&repo), &branches)).await
}

fn find(repo: &Path, branches: &[String]) -> Result<HashMap<String, PullRequest>> {
    let Some(gh) = programs::find("gh") else { return Ok(HashMap::new()) };
    if branches.is_empty() {
        return Ok(HashMap::new());
    }
    // gh fills in `{owner}` and `{repo}` from the repository's remote. Branches go as raw strings
    // (`-f`): with `-F`, one starting with `@` would be read as a file.
    let out = Command::new(gh)
        .current_dir(repo)
        .args(["api", "graphql", "-f", &format!("query={}", query(branches.len())), "-F", "owner={owner}", "-F", "name={repo}"])
        .args(branches.iter().enumerate().flat_map(|(i, branch)| ["-f".to_string(), format!("b{i}={branch}")]))
        .env("PATH", std::env::join_paths(programs::search_path()).unwrap_or_default())
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run gh: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    parse(&String::from_utf8_lossy(&out.stdout), branches)
}

/// One field per branch, `b0`, `b1`…, each with its branch's newest pull requests.
fn query(branches: usize) -> String {
    let vars: String = (0..branches).map(|i| format!(", $b{i}: String!")).collect();
    let fields: String = (0..branches)
        .map(|i| {
            format!(
                " b{i}: pullRequests(headRefName: $b{i}, first: 5, orderBy: {{field: CREATED_AT, direction: DESC}}) \
                 {{ nodes {{ number state url isDraft isCrossRepository reviewDecision latestReviews(first: 20) {{ nodes {{ state }} }} }} }}"
            )
        })
        .collect();
    format!("query($owner: String!, $name: String!{vars}) {{ repository(owner: $owner, name: $name) {{{fields} }} }}")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Node {
    number: u64,
    state: PullState,
    url: String,
    is_draft: bool,
    is_cross_repository: bool,
    /// `None` where the repository doesn't require reviews.
    review_decision: Option<String>,
    latest_reviews: Option<Reviews>,
}

#[derive(Deserialize)]
struct Reviews {
    nodes: Vec<Review>,
}

#[derive(Deserialize)]
struct Review {
    state: String,
}

impl Node {
    /// GitHub's review decision; without one (reviews aren't required), each reviewer's latest
    /// review: an approval, and nobody asking for changes.
    fn approved(&self) -> bool {
        match self.review_decision.as_deref() {
            Some(decision) => decision == "APPROVED",
            None => {
                let states = self.latest_reviews.iter().flat_map(|r| &r.nodes).map(|r| r.state.as_str());
                let states: Vec<&str> = states.collect();
                states.contains(&"APPROVED") && !states.contains(&"CHANGES_REQUESTED")
            }
        }
    }
}

/// Pull requests from forks don't count: theirs is another branch of the same name (a fork's
/// `main`, say).
fn parse(out: &str, branches: &[String]) -> Result<HashMap<String, PullRequest>> {
    let json: serde_json::Value = serde_json::from_str(out).map_err(|e| e.to_string())?;
    let repository = &json["data"]["repository"];
    let mut pulls = HashMap::new();
    for (i, branch) in branches.iter().enumerate() {
        let nodes: Vec<Node> = serde_json::from_value(repository[format!("b{i}")]["nodes"].clone()).unwrap_or_default();
        if let Some(node) = nodes.into_iter().find(|n| !n.is_cross_repository) {
            let approved = node.approved();
            let pull = PullRequest { number: node.number, state: node.state, url: node.url, draft: node.is_draft, approved };
            pulls.insert(branch.clone(), pull);
        }
    }
    Ok(pulls)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_for_each_branch() {
        let q = query(2);
        assert!(q.starts_with("query($owner: String!, $name: String!, $b0: String!, $b1: String!)"), "{q}");
        assert!(q.contains("b1: pullRequests(headRefName: $b1, first: 5"), "{q}");
    }

    #[test]
    fn takes_the_newest_pull_request_not_from_a_fork() {
        let out = r#"{"data":{"repository":{
            "b0":{"nodes":[{"number":9,"state":"OPEN","url":"u9","isDraft":false,"isCrossRepository":true},{"number":7,"state":"CLOSED","url":"u7","isDraft":true,"isCrossRepository":false}]},
            "b1":{"nodes":[]},
            "b2":{"nodes":[{"number":3,"state":"MERGED","url":"u3","isDraft":false,"isCrossRepository":false}]}}}}"#;
        let branches = ["feat/a", "feat/b", "feat/c"].map(String::from);
        let pulls = parse(out, &branches).unwrap();
        assert_eq!(pulls.len(), 2);
        assert_eq!(pulls["feat/a"], PullRequest { number: 7, state: PullState::Closed, url: "u7".into(), draft: true, approved: false });
        assert_eq!(pulls["feat/c"].state, PullState::Merged);
        assert_eq!(serde_json::to_string(&PullState::Closed).unwrap(), "\"closed\"");
    }

    #[test]
    fn reads_approval() {
        let pull = |review: &str| format!(r#"{{"number":1,"state":"OPEN","url":"u","isDraft":false,"isCrossRepository":false,{review}}}"#);
        let out = format!(
            r#"{{"data":{{"repository":{{"b0":{{"nodes":[{}]}},"b1":{{"nodes":[{}]}},"b2":{{"nodes":[{}]}},"b3":{{"nodes":[{}]}}}}}}}}"#,
            pull(r#""reviewDecision":"APPROVED","latestReviews":{"nodes":[]}"#),
            pull(r#""reviewDecision":"REVIEW_REQUIRED","latestReviews":{"nodes":[{"state":"APPROVED"}]}"#),
            // Reviews not required: the reviewers' latest reviews decide.
            pull(r#""reviewDecision":null,"latestReviews":{"nodes":[{"state":"COMMENTED"},{"state":"APPROVED"}]}"#),
            pull(r#""reviewDecision":null,"latestReviews":{"nodes":[{"state":"APPROVED"},{"state":"CHANGES_REQUESTED"}]}"#),
        );
        let branches = ["a", "b", "c", "d"].map(String::from);
        let pulls = parse(&out, &branches).unwrap();
        let approved: Vec<bool> = branches.iter().map(|b| pulls[b].approved).collect();
        assert_eq!(approved, [true, false, true, false]);
    }
}
