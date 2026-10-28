//! Pure helpers that turn Git-service results into persisted `Project` state:
//! status derivation, sync outcomes, and import merging. No IO, so they are unit-tested
//! without launching the service.

use crate::git_service::{FullSyncResult, GitHubRepository, MergeResult, PushResult, StatusInfo};
use crate::models::{
    GitStatus, Project, ProjectStatus, SyncAction, SyncDetails, SyncResult, SyncStatus,
};
use std::collections::HashSet;

// ==================== STATUS ====================

/// Derive the sync state from a service status. Anything that cannot be verified is
/// reported as such, never as synced: a repo needs a readable remote, a tracked
/// upstream and a successful remote read before "synced"/"behind"/"diverged" apply.
/// Unrelated remote branches are informational and never imply a merge is needed.
pub fn determine_sync_status(info: &StatusInfo) -> SyncStatus {
    if info.is_git_repo == Some(false) {
        return SyncStatus::NotConnected;
    }

    let dirty = info.uncommitted_files > 0;
    let ahead = info.unpushed_commits;
    let behind = info.behind_commits;
    let local_changes = dirty || ahead > 0;

    if info.has_remote != Some(true) {
        return if local_changes {
            SyncStatus::LocalChanges
        } else {
            SyncStatus::NotConnected
        };
    }
    if info.remote_error.is_some() || info.remote_checked_at.is_none() {
        return SyncStatus::Unavailable;
    }
    if info.upstream.is_none() {
        return if local_changes {
            SyncStatus::LocalChanges
        } else {
            SyncStatus::NotConnected
        };
    }

    if ahead > 0 && behind > 0 {
        SyncStatus::Diverged
    } else if behind > 0 {
        if dirty {
            SyncStatus::Both
        } else {
            SyncStatus::Behind
        }
    } else if local_changes {
        SyncStatus::LocalChanges
    } else {
        SyncStatus::Synced
    }
}

/// Map a successful service status into the DTO the dashboard loads. `remote_checked_at`
/// is passed through from the service, never stamped here.
pub fn git_status_from_info(info: StatusInfo, now: &str) -> GitStatus {
    let sync_status = determine_sync_status(&info);
    GitStatus {
        is_git_repo: info.is_git_repo.unwrap_or(true),
        has_remote: info.has_remote.unwrap_or(false),
        uncommitted_files: info.uncommitted_files,
        untracked_files: info.untracked_files,
        modified_files: info.modified_files,
        unpushed_commits: info.unpushed_commits,
        remote_branches: info.remote_branches,
        sync_status,
        last_checked: now.to_string(),
        current_branch: info.current_branch,
        upstream: info.upstream,
        remote_url: info.remote_url,
        behind_commits: info.behind_commits,
        remote_checked_at: info.remote_checked_at,
        remote_error: info.remote_error,
    }
}

/// Status for a check that failed outright. Facts from the last successful check are
/// kept (with their original `last_checked`) but the sync state becomes `Unavailable`,
/// so a stale "synced" is never shown as current. With no earlier check nothing is
/// confirmed, so the git booleans are false.
pub fn unavailable_git_status(previous: Option<&GitStatus>, error: &str, now: &str) -> GitStatus {
    let mut status = previous.cloned().unwrap_or_else(|| GitStatus {
        is_git_repo: false,
        has_remote: false,
        uncommitted_files: 0,
        untracked_files: 0,
        modified_files: Vec::new(),
        unpushed_commits: 0,
        remote_branches: Vec::new(),
        sync_status: SyncStatus::Unavailable,
        last_checked: now.to_string(),
        current_branch: None,
        upstream: None,
        remote_url: None,
        behind_commits: 0,
        remote_checked_at: None,
        remote_error: None,
    });
    status.sync_status = SyncStatus::Unavailable;
    status.remote_checked_at = None;
    status.remote_error = Some(format!("Status check failed: {}", error));
    status
}

/// Status from a service call result, falling back to `unavailable_git_status`.
pub fn status_from_check(
    check: Result<StatusInfo, String>,
    previous: Option<&GitStatus>,
    now: &str,
) -> GitStatus {
    match check {
        Ok(info) => git_status_from_info(info, now),
        Err(error) => unavailable_git_status(previous, &error, now),
    }
}

fn has_github_link(project: &Project) -> bool {
    project.github_url.is_some() || project.github_owner.is_some() || project.github_repo.is_some()
}

/// Conservative dashboard state. The richer `GitStatus` carries the detail; only a
/// project linked to both GitHub and a local path is ever marked as needing an action.
pub fn project_status_for(project: &Project, sync: &SyncStatus) -> ProjectStatus {
    match (project.local_path.is_some(), has_github_link(project)) {
        (false, false) => ProjectStatus::NotConfigured,
        (false, true) => ProjectStatus::GithubOnly,
        (true, false) => ProjectStatus::LocalOnly,
        (true, true) => match sync {
            SyncStatus::Synced => ProjectStatus::Synced,
            SyncStatus::LocalChanges => ProjectStatus::NeedsPush,
            SyncStatus::Both | SyncStatus::Diverged => ProjectStatus::NeedsSync,
            SyncStatus::Behind | SyncStatus::RemoteBranches => ProjectStatus::NeedsMerge,
            SyncStatus::NotConnected | SyncStatus::Unavailable => ProjectStatus::Ready,
        },
    }
}

pub fn apply_git_status(project: &mut Project, status: GitStatus) {
    project.project_status = project_status_for(project, &status.sync_status);
    project.git_status = Some(status);
}

// ==================== SYNC OUTCOMES ====================

fn details(committed: Option<u32>, pushed: Option<u32>) -> SyncDetails {
    SyncDetails {
        committed,
        pushed,
        pulled: None,
        merged: None,
        deleted: None,
        errors: None,
    }
}

/// Outcome of a push. The pushed count comes from the service's own flag; a commit
/// that was not pushed is a failure so callers never record it as synced.
pub fn push_outcome(result: &PushResult) -> SyncResult {
    let pushed = result.pushed_count();
    let committed = result.committed;
    let mut details = details(Some(committed), Some(pushed));

    let (success, message) = match (pushed, committed) {
        (0, 0) => (
            true,
            "Nothing to push: no changes were committed or pushed".to_string(),
        ),
        (0, c) => {
            let message = format!(
                "Committed {} change(s) locally but the push did not complete",
                c
            );
            details.errors = Some(vec![message.clone()]);
            (false, message)
        }
        (_, 0) => (true, "Pushed existing commits to the remote".to_string()),
        (_, c) => (
            true,
            format!("Committed {} change(s) and pushed to the remote", c),
        ),
    };

    SyncResult {
        success,
        message,
        details,
    }
}

pub fn merge_outcome(result: MergeResult) -> SyncResult {
    let message = if result.merged.is_empty() {
        "No branches were merged".to_string()
    } else {
        format!("Merged {} branch(es)", result.merged.len())
    };
    SyncResult {
        success: true,
        message,
        details: SyncDetails {
            merged: Some(result.merged),
            deleted: result.deleted,
            ..details(None, None)
        },
    }
}

/// The service reports pulled branches only; nothing about pushing or deleting.
pub fn pull_outcome(pulled: Vec<String>) -> SyncResult {
    let message = if pulled.is_empty() {
        "No branches were pulled".to_string()
    } else {
        format!("Pulled {} branch(es)", pulled.len())
    };
    SyncResult {
        success: true,
        message,
        details: SyncDetails {
            merged: Some(pulled),
            ..details(None, None)
        },
    }
}

/// Service fields pass through unchanged; success requires the service's own success
/// and an empty error list.
pub fn full_sync_outcome(result: FullSyncResult) -> SyncResult {
    let has_errors = result
        .errors
        .as_ref()
        .map_or(false, |errors| !errors.is_empty());
    let message = if result.success && has_errors {
        "Full sync completed with errors".to_string()
    } else {
        result.message
    };
    SyncResult {
        success: result.success && !has_errors,
        message,
        details: SyncDetails {
            committed: result.committed,
            pushed: result.pushed,
            pulled: result.pulled,
            merged: result.merged,
            deleted: result.deleted,
            errors: result.errors,
        },
    }
}

/// Whether an outcome proves data actually moved to or from the remote. Failed and
/// partial results, and no-ops, must not advance `last_synced`.
pub fn advances_last_synced(action: &SyncAction, result: &SyncResult) -> bool {
    if !result.success {
        return false;
    }
    match action {
        SyncAction::PushLocal { .. } => result.details.pushed.unwrap_or(0) > 0,
        SyncAction::FullSync { .. } => result.details.pushed.unwrap_or(0) > 0 || result.details.pulled.unwrap_or(0) > 0,
        SyncAction::MergeBranches { .. } | SyncAction::PullBranches { .. } => result
            .details
            .merged
            .as_ref()
            .map_or(false, |merged| !merged.is_empty()),
    }
}

// ==================== IMPORT ====================

/// Comparison key for a local path: separators and case (on Windows) are normalized and
/// `.`/empty segments and trailing separators dropped. `..` is left alone because it may
/// cross a link; the key is only for deduplication, never for filesystem access.
pub fn normalize_path_key(path: &str) -> String {
    let mut text = path.trim().to_string();
    if cfg!(windows) {
        text = text.replace('\\', "/");
    }
    if let Some(rest) = text.strip_prefix("//?/") {
        text = rest.to_string();
    }
    let rooted = text.starts_with('/');
    let joined = text
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        return String::new();
    }
    let key = if rooted {
        format!("/{}", joined)
    } else {
        joined
    };
    if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    }
}

fn identity_from_url(url: &str) -> Option<String> {
    let (_, after_host) = url.trim().split_once("github.com")?;
    let mut parts = after_host
        .trim_start_matches(|c| c == '/' || c == ':')
        .split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim().trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{}/{}", owner, repo).to_lowercase())
}

/// Lower-cased `owner/repo`. Projects store the link inconsistently (a URL, a bare repo
/// name plus owner, or a full name), so every shape resolves to the same key.
pub fn github_identity(
    owner: Option<&str>,
    repo: Option<&str>,
    url: Option<&str>,
) -> Option<String> {
    if let Some(identity) = url.and_then(identity_from_url) {
        return Some(identity);
    }
    let repo = repo?.trim().trim_end_matches(".git");
    if repo.is_empty() {
        return None;
    }
    if let Some((repo_owner, repo_name)) = repo.split_once('/') {
        if repo_owner.is_empty() || repo_name.is_empty() {
            return None;
        }
        return Some(repo.to_lowercase());
    }
    let owner = owner?.trim();
    if owner.is_empty() {
        return None;
    }
    Some(format!("{}/{}", owner, repo).to_lowercase())
}

fn project_identity(project: &Project) -> Option<String> {
    github_identity(
        project.github_owner.as_deref(),
        project.github_repo.as_deref(),
        project.github_url.as_deref(),
    )
}

/// Ids stay `name-<unix seconds>`, as before, with a numeric suffix when a batch import
/// produces the same id twice (same-named folders scanned in the same second).
fn unique_id(projects: &[Project], name: &str) -> String {
    let base = format!("{}-{}", name, chrono::Utc::now().timestamp());
    let taken: HashSet<&str> = projects.iter().map(|p| p.id.as_str()).collect();
    if !taken.contains(base.as_str()) {
        return base;
    }
    (2..)
        .map(|n| format!("{}-{}", base, n))
        .find(|candidate| !taken.contains(candidate.as_str()))
        .expect("an unused suffix always exists")
}

/// A local repository found by scanning, with the outcome of its status check.
pub struct LocalRepoImport {
    pub path: String,
    pub name: String,
    pub check: Result<StatusInfo, String>,
}

/// Merge a scanned repository into the project list. A project already at the same
/// (normalized) path keeps its id and every user field; only its git status is refreshed.
pub fn merge_local_import(
    projects: &mut Vec<Project>,
    import: LocalRepoImport,
    now: &str,
) -> Project {
    let key = normalize_path_key(&import.path);
    let existing = projects.iter().position(|p| {
        p.local_path.as_deref().map(normalize_path_key).as_deref() == Some(key.as_str())
    });

    if let Some(index) = existing {
        let project = &mut projects[index];
        let status = status_from_check(import.check, project.git_status.as_ref(), now);
        apply_git_status(project, status);
        return project.clone();
    }

    let mut project = Project {
        id: unique_id(projects, &import.name),
        name: import.name,
        github_owner: None,
        github_repo: None,
        github_url: None,
        local_path: Some(import.path),
        project_status: ProjectStatus::LocalOnly,
        git_status: None,
        created_at: now.to_string(),
        last_synced: None,
        description: None,
        archived: None,
        favorite: None,
        last_activity: None,
        statistics: None,
        template: None,
        labels: Vec::new(),
    };
    let status = status_from_check(import.check, None, now);
    apply_git_status(&mut project, status);
    projects.push(project.clone());
    project
}

/// Merge a GitHub repository into the project list. A project with the same GitHub
/// identity (with or without a local path) keeps its id and user fields; only missing
/// GitHub link fields are filled in.
pub fn merge_github_import(
    projects: &mut Vec<Project>,
    repo: &GitHubRepository,
    now: &str,
) -> Project {
    let identity = github_identity(
        Some(&repo.owner),
        Some(&repo.full_name),
        Some(&repo.clone_url),
    );
    let existing = identity.as_ref().and_then(|id| {
        projects
            .iter()
            .position(|p| project_identity(p).as_ref() == Some(id))
    });

    if let Some(index) = existing {
        let project = &mut projects[index];
        if project.github_owner.is_none() {
            project.github_owner = Some(repo.owner.clone());
        }
        if project.github_repo.is_none() {
            project.github_repo = Some(repo.full_name.clone());
        }
        if project.github_url.is_none() {
            project.github_url = Some(repo.clone_url.clone());
        }
        project.project_status = match &project.git_status {
            Some(status) => project_status_for(project, &status.sync_status),
            None => project_status_for(project, &SyncStatus::NotConnected),
        };
        return project.clone();
    }

    let project = Project {
        id: unique_id(projects, &repo.name),
        name: repo.name.clone(),
        github_owner: Some(repo.owner.clone()),
        github_repo: Some(repo.full_name.clone()),
        github_url: Some(repo.clone_url.clone()),
        local_path: None,
        project_status: ProjectStatus::GithubOnly,
        git_status: None,
        created_at: now.to_string(),
        last_synced: None,
        description: None,
        archived: None,
        favorite: None,
        last_activity: None,
        statistics: None,
        template: None,
        labels: Vec::new(),
    };
    projects.push(project.clone());
    project
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-09-21T12:00:00Z";
    const REMOTE_READ: &str = "2026-09-21T11:59:00Z";

    // A repo whose remote was read successfully and whose branch tracks origin/main.
    fn tracked() -> StatusInfo {
        StatusInfo {
            is_git_repo: Some(true),
            has_remote: Some(true),
            current_branch: Some("main".to_string()),
            upstream: Some("origin/main".to_string()),
            remote_url: None,
            behind_commits: 0,
            remote_checked_at: Some(REMOTE_READ.to_string()),
            remote_error: None,
            uncommitted_files: 0,
            untracked_files: 0,
            modified_files: Vec::new(),
            unpushed_commits: 0,
            remote_branches: Vec::new(),
        }
    }

    fn project(id: &str, path: Option<&str>, github: Option<(&str, &str)>) -> Project {
        Project {
            id: id.to_string(),
            name: id.to_string(),
            github_owner: github.map(|(o, _)| o.to_string()),
            github_repo: github.map(|(_, r)| r.to_string()),
            github_url: github.map(|(o, r)| format!("https://github.com/{}/{}.git", o, r)),
            local_path: path.map(str::to_string),
            project_status: ProjectStatus::NotConfigured,
            git_status: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            last_synced: None,
            description: None,
            archived: None,
            favorite: None,
            last_activity: None,
            statistics: None,
            template: None,
            labels: Vec::new(),
        }
    }

    fn gh_repo(owner: &str, name: &str) -> GitHubRepository {
        GitHubRepository {
            name: name.to_string(),
            full_name: format!("{}/{}", owner, name),
            clone_url: format!("https://github.com/{}/{}.git", owner, name),
            html_url: format!("https://github.com/{}/{}", owner, name),
            owner: owner.to_string(),
            is_private: false,
            default_branch: "main".to_string(),
        }
    }

    // ---- status derivation ----

    #[test]
    fn clean_tracked_repo_with_a_successful_remote_read_is_synced() {
        assert_eq!(determine_sync_status(&tracked()), SyncStatus::Synced);
    }

    #[test]
    fn unrelated_remote_branches_do_not_mean_a_merge_is_needed() {
        let mut info = tracked();
        info.remote_branches = vec!["feature/a".to_string(), "dependabot/x".to_string()];
        assert_eq!(determine_sync_status(&info), SyncStatus::Synced);
    }

    #[test]
    fn local_work_ahead_or_uncommitted_is_local_changes() {
        let mut ahead = tracked();
        ahead.unpushed_commits = 2;
        assert_eq!(determine_sync_status(&ahead), SyncStatus::LocalChanges);

        let mut dirty = tracked();
        dirty.uncommitted_files = 1;
        assert_eq!(determine_sync_status(&dirty), SyncStatus::LocalChanges);
    }

    #[test]
    fn behind_and_diverged_are_distinguished() {
        let mut behind = tracked();
        behind.behind_commits = 3;
        assert_eq!(determine_sync_status(&behind), SyncStatus::Behind);

        let mut dirty_behind = tracked();
        dirty_behind.behind_commits = 1;
        dirty_behind.uncommitted_files = 1;
        assert_eq!(determine_sync_status(&dirty_behind), SyncStatus::Both);

        let mut diverged = tracked();
        diverged.behind_commits = 1;
        diverged.unpushed_commits = 1;
        assert_eq!(determine_sync_status(&diverged), SyncStatus::Diverged);
    }

    #[test]
    fn a_remote_read_failure_is_unavailable_even_when_counts_look_clean() {
        let mut info = tracked();
        info.remote_error = Some("could not resolve host".to_string());
        assert_eq!(determine_sync_status(&info), SyncStatus::Unavailable);
    }

    #[test]
    fn no_remote_read_timestamp_means_no_synced_claim() {
        let mut info = tracked();
        info.remote_checked_at = None;
        assert_eq!(determine_sync_status(&info), SyncStatus::Unavailable);
    }

    #[test]
    fn no_remote_is_not_connected_unless_local_changes_exist() {
        let mut info = tracked();
        info.has_remote = Some(false);
        info.upstream = None;
        info.remote_checked_at = None;
        assert_eq!(determine_sync_status(&info), SyncStatus::NotConnected);

        info.uncommitted_files = 4;
        assert_eq!(determine_sync_status(&info), SyncStatus::LocalChanges);
    }

    #[test]
    fn an_untracked_branch_is_not_reported_as_synced() {
        let mut info = tracked();
        info.upstream = None;
        assert_eq!(determine_sync_status(&info), SyncStatus::NotConnected);
    }

    #[test]
    fn a_non_repository_is_not_connected() {
        let mut info = tracked();
        info.is_git_repo = Some(false);
        info.has_remote = Some(false);
        assert_eq!(determine_sync_status(&info), SyncStatus::NotConnected);
    }

    #[test]
    fn a_service_that_omits_the_new_fields_never_yields_synced() {
        let info: StatusInfo = serde_json::from_value(serde_json::json!({
            "uncommittedFiles": 0, "untrackedFiles": 0, "modifiedFiles": [],
            "unpushedCommits": 0, "remoteBranches": []
        }))
        .unwrap();
        assert_ne!(determine_sync_status(&info), SyncStatus::Synced);
    }

    #[test]
    fn git_status_passes_service_fields_through_without_stamping_the_remote_check() {
        let status = git_status_from_info(tracked(), NOW);
        assert_eq!(status.sync_status, SyncStatus::Synced);
        assert_eq!(status.last_checked, NOW);
        assert_eq!(status.remote_checked_at.as_deref(), Some(REMOTE_READ));
        assert_eq!(status.current_branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
    }

    #[test]
    fn a_failed_check_replaces_a_previous_synced_status() {
        let previous = git_status_from_info(tracked(), "2026-09-20T00:00:00Z");
        assert_eq!(previous.sync_status, SyncStatus::Synced);

        let status =
            status_from_check(Err("service not running".to_string()), Some(&previous), NOW);
        assert_eq!(status.sync_status, SyncStatus::Unavailable);
        assert_eq!(status.remote_checked_at, None);
        assert!(status
            .remote_error
            .as_deref()
            .unwrap()
            .contains("service not running"));
        // Last-known facts keep their own timestamp so staleness stays visible.
        assert_eq!(status.last_checked, "2026-09-20T00:00:00Z");
    }

    #[test]
    fn a_failed_first_check_confirms_nothing() {
        let status = status_from_check(Err("boom".to_string()), None, NOW);
        assert_eq!(status.sync_status, SyncStatus::Unavailable);
        assert!(!status.is_git_repo);
        assert!(!status.has_remote);
        assert_eq!(status.last_checked, NOW);
    }

    #[test]
    fn project_status_is_conservative() {
        let linked = project("a", Some("C:/a"), Some(("o", "a")));
        assert_eq!(
            project_status_for(&linked, &SyncStatus::Synced),
            ProjectStatus::Synced
        );
        assert_eq!(
            project_status_for(&linked, &SyncStatus::LocalChanges),
            ProjectStatus::NeedsPush
        );
        assert_eq!(
            project_status_for(&linked, &SyncStatus::Behind),
            ProjectStatus::NeedsMerge
        );
        assert_eq!(
            project_status_for(&linked, &SyncStatus::Diverged),
            ProjectStatus::NeedsSync
        );
        assert_eq!(
            project_status_for(&linked, &SyncStatus::Both),
            ProjectStatus::NeedsSync
        );
        assert_eq!(
            project_status_for(&linked, &SyncStatus::Unavailable),
            ProjectStatus::Ready
        );
        assert_eq!(
            project_status_for(&linked, &SyncStatus::NotConnected),
            ProjectStatus::Ready
        );
    }

    #[test]
    fn local_only_and_github_only_projects_are_never_marked_synced() {
        let local = project("l", Some("C:/l"), None);
        assert_eq!(
            project_status_for(&local, &SyncStatus::Synced),
            ProjectStatus::LocalOnly
        );
        let remote = project("r", None, Some(("o", "r")));
        assert_eq!(
            project_status_for(&remote, &SyncStatus::Synced),
            ProjectStatus::GithubOnly
        );
        let neither = project("n", None, None);
        assert_eq!(
            project_status_for(&neither, &SyncStatus::Synced),
            ProjectStatus::NotConfigured
        );
    }

    // ---- sync outcomes ----

    #[test]
    fn push_outcome_counts_come_from_the_service_flag() {
        let pushed = push_outcome(&PushResult {
            committed: 3,
            pushed: true,
        });
        assert!(pushed.success);
        assert_eq!(pushed.details.pushed, Some(1));
        assert_eq!(pushed.details.committed, Some(3));

        let nothing = push_outcome(&PushResult {
            committed: 0,
            pushed: false,
        });
        assert!(nothing.success);
        assert_eq!(nothing.details.pushed, Some(0));
        assert!(nothing.message.starts_with("Nothing to push"));
    }

    #[test]
    fn a_commit_that_was_not_pushed_is_a_failure() {
        let outcome = push_outcome(&PushResult {
            committed: 2,
            pushed: false,
        });
        assert!(!outcome.success);
        assert_eq!(outcome.details.pushed, Some(0));
        assert_eq!(outcome.details.errors.as_ref().map(Vec::len), Some(1));
    }

    #[test]
    fn full_sync_outcome_never_invents_pushed_or_deleted() {
        let outcome = full_sync_outcome(FullSyncResult {
            success: true,
            message: "Full sync completed".to_string(),
            committed: Some(2),
            pushed: None,
            pulled: None,
            merged: Some(vec!["feature".to_string()]),
            deleted: None,
            errors: None,
        });
        assert!(outcome.success);
        assert_eq!(outcome.details.pushed, None);
        assert_eq!(outcome.details.deleted, None);
        assert_eq!(outcome.details.merged, Some(vec!["feature".to_string()]));

        let reported = full_sync_outcome(FullSyncResult {
            success: true,
            message: "ok".to_string(),
            committed: Some(0),
            pushed: Some(0),
            pulled: None,
            merged: None,
            deleted: None,
            errors: None,
        });
        assert_eq!(reported.details.pushed, Some(0));
    }

    #[test]
    fn full_sync_with_errors_is_not_success_even_if_the_service_said_so() {
        let outcome = full_sync_outcome(FullSyncResult {
            success: true,
            message: "Full sync completed".to_string(),
            committed: Some(1),
            pushed: Some(1),
            pulled: None,
            merged: None,
            deleted: None,
            errors: Some(vec!["Merge failed: conflict".to_string()]),
        });
        assert!(!outcome.success);
        assert_eq!(outcome.message, "Full sync completed with errors");
    }

    #[test]
    fn merge_and_pull_outcomes_report_only_what_the_service_returned() {
        let merged = merge_outcome(MergeResult {
            merged: vec!["a".to_string()],
            deleted: None,
        });
        assert_eq!(merged.details.deleted, None);
        assert_eq!(merged.details.pushed, None);

        let pulled = pull_outcome(vec!["a".to_string(), "b".to_string()]);
        assert_eq!(pulled.details.pushed, None);
        assert_eq!(pulled.details.deleted, None);
        assert_eq!(pulled.message, "Pulled 2 branch(es)");
    }

    fn push_action() -> SyncAction {
        SyncAction::PushLocal {
            commit_message: None,
            commit_description: None,
            selected_files: None,
            allow_warnings: false,
        }
    }

    fn full_action() -> SyncAction {
        SyncAction::FullSync {
            commit_message: None,
            commit_description: None,
            selected_files: None,
            allow_warnings: false,
        }
    }

    #[test]
    fn last_synced_advances_only_on_verified_movement() {
        let pushed = push_outcome(&PushResult {
            committed: 1,
            pushed: true,
        });
        assert!(advances_last_synced(&push_action(), &pushed));

        let noop = push_outcome(&PushResult {
            committed: 0,
            pushed: false,
        });
        assert!(!advances_last_synced(&push_action(), &noop));

        let partial = push_outcome(&PushResult {
            committed: 1,
            pushed: false,
        });
        assert!(!advances_last_synced(&push_action(), &partial));

        let failed_full = full_sync_outcome(FullSyncResult {
            success: false,
            message: "Full sync failed: offline".to_string(),
            committed: None,
            pushed: None,
            pulled: None,
            merged: None,
            deleted: None,
            errors: Some(vec!["offline".to_string()]),
        });
        assert!(!advances_last_synced(&full_action(), &failed_full));

        let ok_full = full_sync_outcome(FullSyncResult {
            success: true,
            message: "Full sync completed".to_string(),
            committed: Some(0),
            pushed: Some(0),
            pulled: None,
            merged: None,
            deleted: None,
            errors: None,
        });
        assert!(!advances_last_synced(&full_action(), &ok_full));
        let mut fast_forwarded = ok_full;
        fast_forwarded.details.pulled = Some(2);
        assert!(advances_last_synced(&full_action(), &fast_forwarded));
    }

    // ---- import: keys ----

    #[test]
    fn path_keys_ignore_trailing_separators_and_dot_segments() {
        assert_eq!(
            normalize_path_key("C:/Repos/App/"),
            normalize_path_key("C:/Repos/./App")
        );
        assert_eq!(
            normalize_path_key("  C:/Repos/App  "),
            normalize_path_key("C:/Repos/App")
        );
        assert_ne!(
            normalize_path_key("C:/Repos/App"),
            normalize_path_key("C:/Repos/App2")
        );
        assert_eq!(normalize_path_key(""), "");
    }

    #[cfg(windows)]
    #[test]
    fn windows_path_keys_ignore_case_separators_and_verbatim_prefix() {
        let plain = normalize_path_key("C:\\Repos\\App");
        assert_eq!(plain, normalize_path_key("c:/repos/app/"));
        assert_eq!(plain, normalize_path_key("\\\\?\\C:\\Repos\\App"));
    }

    #[test]
    fn github_identity_resolves_every_stored_shape_to_one_key() {
        let expected = Some("octo/app".to_string());
        assert_eq!(
            github_identity(None, None, Some("https://github.com/Octo/App.git")),
            expected
        );
        assert_eq!(
            github_identity(None, None, Some("git@github.com:octo/app.git")),
            expected
        );
        assert_eq!(github_identity(Some("octo"), Some("app"), None), expected);
        assert_eq!(
            github_identity(Some("octo"), Some("Octo/App"), None),
            expected
        );
        assert_eq!(github_identity(None, Some("app"), None), None);
        assert_eq!(github_identity(None, None, None), None);
    }

    // ---- import: local ----

    fn local_import(path: &str, name: &str, check: Result<StatusInfo, String>) -> LocalRepoImport {
        LocalRepoImport {
            path: path.to_string(),
            name: name.to_string(),
            check,
        }
    }

    #[test]
    fn a_new_local_import_is_added_as_local_only_even_when_clean() {
        let mut projects = Vec::new();
        let created = merge_local_import(
            &mut projects,
            local_import("C:/src/app", "app", Ok(tracked())),
            NOW,
        );
        assert_eq!(projects.len(), 1);
        assert_eq!(created.project_status, ProjectStatus::LocalOnly);
        assert_eq!(created.git_status.unwrap().sync_status, SyncStatus::Synced);
        assert_eq!(created.local_path.as_deref(), Some("C:/src/app"));
    }

    #[test]
    fn reimporting_a_path_keeps_the_id_and_user_fields_and_refreshes_status() {
        let mut existing = project("keep-me", Some("C:/src/app"), None);
        existing.favorite = Some(true);
        existing.description = Some("mine".to_string());
        existing.labels = vec!["Work".to_string()];
        existing.last_synced = Some("2026-02-02T00:00:00Z".to_string());
        let mut projects = vec![existing];

        let mut dirty = tracked();
        dirty.uncommitted_files = 2;
        let updated = merge_local_import(
            &mut projects,
            // Different spelling of the same folder.
            local_import("C:/src/app/", "app", Ok(dirty)),
            NOW,
        );

        assert_eq!(projects.len(), 1, "no duplicate project");
        assert_eq!(updated.id, "keep-me");
        assert_eq!(updated.favorite, Some(true));
        assert_eq!(updated.description.as_deref(), Some("mine"));
        assert_eq!(updated.labels, vec!["Work".to_string()]);
        assert_eq!(updated.last_synced.as_deref(), Some("2026-02-02T00:00:00Z"));
        assert_eq!(
            updated.git_status.unwrap().sync_status,
            SyncStatus::LocalChanges
        );
    }

    #[test]
    fn reimporting_a_linked_project_maps_status_through_its_github_link() {
        let mut projects = vec![project("linked", Some("C:/src/app"), Some(("octo", "app")))];
        let mut ahead = tracked();
        ahead.unpushed_commits = 1;
        let updated = merge_local_import(
            &mut projects,
            local_import("C:/src/app", "app", Ok(ahead)),
            NOW,
        );
        assert_eq!(updated.project_status, ProjectStatus::NeedsPush);
    }

    #[test]
    fn a_failed_status_check_on_reimport_does_not_keep_a_false_synced_state() {
        let mut existing = project("linked", Some("C:/src/app"), Some(("octo", "app")));
        apply_git_status(
            &mut existing,
            git_status_from_info(tracked(), "2026-09-20T00:00:00Z"),
        );
        assert_eq!(existing.project_status, ProjectStatus::Synced);
        let mut projects = vec![existing];

        let updated = merge_local_import(
            &mut projects,
            local_import("C:/src/app", "app", Err("path not found".to_string())),
            NOW,
        );
        assert_eq!(updated.project_status, ProjectStatus::Ready);
        assert_eq!(
            updated.git_status.unwrap().sync_status,
            SyncStatus::Unavailable
        );
    }

    #[test]
    fn same_named_folders_imported_together_get_distinct_ids() {
        let mut projects = Vec::new();
        let a = merge_local_import(
            &mut projects,
            local_import("C:/a/app", "app", Ok(tracked())),
            NOW,
        );
        let b = merge_local_import(
            &mut projects,
            local_import("C:/b/app", "app", Ok(tracked())),
            NOW,
        );
        assert_ne!(a.id, b.id);
        assert_eq!(projects.len(), 2);
    }

    // ---- import: GitHub ----

    #[test]
    fn a_new_github_repo_is_added_as_github_only() {
        let mut projects = Vec::new();
        let created = merge_github_import(&mut projects, &gh_repo("octo", "app"), NOW);
        assert_eq!(created.project_status, ProjectStatus::GithubOnly);
        assert_eq!(created.github_repo.as_deref(), Some("octo/app"));
        assert_eq!(created.local_path, None);
        assert_eq!(projects.len(), 1);
    }

    #[test]
    fn a_github_repo_matching_a_linked_local_project_is_not_duplicated() {
        // Linked earlier by URL with a bare repo name, as create_github_repository stores it.
        let mut linked = project("linked", Some("C:/src/app"), Some(("Octo", "App")));
        linked.favorite = Some(true);
        linked.labels = vec!["Work".to_string()];
        let mut projects = vec![linked];

        let result = merge_github_import(&mut projects, &gh_repo("octo", "app"), NOW);
        assert_eq!(projects.len(), 1);
        assert_eq!(result.id, "linked");
        assert_eq!(result.favorite, Some(true));
        assert_eq!(result.labels, vec!["Work".to_string()]);
        assert_eq!(result.local_path.as_deref(), Some("C:/src/app"));
    }

    #[test]
    fn importing_github_repos_twice_is_idempotent() {
        let mut projects = Vec::new();
        let first = merge_github_import(&mut projects, &gh_repo("octo", "app"), NOW);
        let second = merge_github_import(
            &mut projects,
            &gh_repo("octo", "app"),
            "2026-09-22T00:00:00Z",
        );
        assert_eq!(projects.len(), 1);
        assert_eq!(first.id, second.id);
        assert_eq!(second.created_at, first.created_at);
    }

    #[test]
    fn a_github_import_fills_only_missing_link_fields() {
        let mut existing = project("p", Some("C:/src/app"), None);
        existing.github_url = Some("https://github.com/octo/app".to_string());
        let mut projects = vec![existing];

        let result = merge_github_import(&mut projects, &gh_repo("octo", "app"), NOW);
        assert_eq!(
            result.github_url.as_deref(),
            Some("https://github.com/octo/app"),
            "existing value kept"
        );
        assert_eq!(result.github_owner.as_deref(), Some("octo"));
        assert_eq!(result.github_repo.as_deref(), Some("octo/app"));
    }

    #[test]
    fn different_repos_with_the_same_name_are_not_merged() {
        let mut projects = vec![project("mine", None, Some(("octo", "app")))];
        merge_github_import(&mut projects, &gh_repo("someone-else", "app"), NOW);
        assert_eq!(projects.len(), 2);
        assert_ne!(projects[0].id, projects[1].id);
    }
}
