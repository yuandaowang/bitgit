use crate::app_settings::{self, EditorConfig, EditorPreset};
use crate::credentials::CredentialManager;
use crate::git_service::{GitService, PublishOptions, StashInfo, TagInfo, BranchInfo, CommitInfo, DiffInfo, FileChangeInfo, AnalyticsSnapshotResult};
use crate::models::*;
use crate::project_cache;
use crate::project_sync::{self, LocalRepoImport};
use crate::recovery_request;
use crate::scanner::RepositoryScanner;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

// Global Git service instance (Arc allows multiple references without dropping)
static GIT_SERVICE: Lazy<Mutex<Option<Arc<GitService>>>> = Lazy::new(|| Mutex::new(None));

/// Helper to safely acquire a mutex lock, handling poison errors gracefully.
/// If the lock is poisoned (previous holder panicked), we recover by accessing the data anyway.
fn safe_lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex.lock().map_err(|e: PoisonError<MutexGuard<T>>| {
        // Recover from poison - the data may be in an inconsistent state but we log it
        eprintln!("[Rust] Warning: Mutex was poisoned, recovering...");
        format!("Lock acquisition failed (poisoned): {}", e)
    })
}

fn get_git_service() -> Result<Arc<GitService>, String> {
    let mut service_guard = safe_lock(&GIT_SERVICE)?;

    if service_guard.is_none() {
        eprintln!("[Rust] Initializing Git service...");
        let service = GitService::new()
            .map_err(|e| format!("Failed to start Git service: {}", e))?;
        *service_guard = Some(Arc::new(service));
    }

    // Clone the Arc to return a reference to the same service
    service_guard
        .as_ref()
        .ok_or_else(|| "Git service not available".to_string())
        .map(|arc| Arc::clone(arc))
}

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to BitGit!", name)
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Read one saved project from the cache.
fn find_project(project_id: &str) -> Result<Project, String> {
    project_cache::load_projects()
        .map_err(|e| format!("Failed to load projects: {}", e))?
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("Project not found: {}", project_id))
}

/// Re-check a project's local repository and persist the result. GitHub is not
/// required, so local-only sources are checked too. A failed check is stored as
/// `Unavailable` so an older synced status cannot be shown as current.
fn refresh_project_status(project_id: &str) -> Result<Project, String> {
    let project = find_project(project_id)?;
    let Some(local_path) = project.local_path.clone() else {
        return Ok(project);
    };

    let check = get_git_service()
        .and_then(|service| service.check_status(&local_path).map_err(|e| e.to_string()));
    if let Err(error) = &check {
        eprintln!("[Rust] Status check failed for project {}: {}", project.id, error);
    }

    let status = project_sync::status_from_check(check, project.git_status.as_ref(), &now_rfc3339());
    // Re-read under the cache lock: the check is slow and other commands may have
    // edited the project meanwhile.
    project_cache::update_project(project_id, |p| project_sync::apply_git_status(p, status))
        .map_err(|e| format!("Failed to save project: {}", e))
}

/// Run a sync action for a saved project. Results report only what the service
/// returned, and `last_synced` advances only when data actually moved.
fn run_sync(project_id: &str, action: SyncAction) -> Result<SyncResult, String> {
    let project = find_project(project_id)?;
    let local_path = project.local_path
        .as_deref()
        .ok_or_else(|| "Project has no local path".to_string())?;

    let service = get_git_service()?;

    // Get GitHub URL as Option<&str> for passing to git service
    let remote_url = project.github_url.as_deref();

    let result = match &action {
        SyncAction::PushLocal { commit_message, commit_description, selected_files, allow_warnings } => {
            let options = PublishOptions {
                selected_files: selected_files.clone(),
                allow_warnings: *allow_warnings,
            };
            let pushed = service.push_local(
                local_path,
                remote_url,
                commit_message.as_deref(),
                commit_description.as_deref(),
                &options,
            ).map_err(|e| format!("Push failed: {}", e))?;
            project_sync::push_outcome(&pushed)
        }
        SyncAction::MergeBranches { branches } => {
            let merged = service.merge_branches(local_path, branches, remote_url)
                .map_err(|e| format!("Merge failed: {}", e))?;
            project_sync::merge_outcome(merged)
        }
        SyncAction::PullBranches { branches } => {
            let pulled = service.pull_branches(local_path, branches, remote_url)
                .map_err(|e| format!("Pull failed: {}", e))?;
            project_sync::pull_outcome(pulled)
        }
        SyncAction::FullSync { commit_message, commit_description, selected_files, allow_warnings } => {
            let options = PublishOptions {
                selected_files: selected_files.clone(),
                allow_warnings: *allow_warnings,
            };
            let synced = service.full_sync(
                local_path,
                remote_url,
                commit_message.as_deref(),
                commit_description.as_deref(),
                &options,
            ).map_err(|e| format!("Full sync failed: {}", e))?;
            project_sync::full_sync_outcome(synced)
        }
    };

    if project_sync::advances_last_synced(&action, &result) {
        let now = now_rfc3339();
        if let Err(e) = project_cache::update_project(project_id, |p| p.last_synced = Some(now)) {
            eprintln!("[Rust] Warning: sync succeeded but last-synced was not saved: {}", e);
        }
    }

    Ok(result)
}

// The three commands below predate the persistent project cache. They now read and
// write the same saved projects as the dashboard, so nothing lives only in memory.

#[tauri::command]
pub async fn get_repositories() -> Result<Vec<Repository>, String> {
    project_cache::load_projects()
        .map_err(|e| format!("Failed to load projects: {}", e))
}

#[tauri::command]
pub async fn check_repository_status(repo_id: String) -> Result<RepositoryStatus, String> {
    let project = refresh_project_status(&repo_id)?;
    if project.local_path.is_none() {
        return Err("Repository has no local path".to_string());
    }
    project.git_status
        .ok_or_else(|| "Repository status is unavailable".to_string())
}

#[tauri::command]
pub async fn sync_repository(id: String, action: SyncAction) -> Result<SyncResult, String> {
    run_sync(&id, action)
}

#[tauri::command]
pub async fn save_github_token(username: String, token: String) -> Result<(), String> {
    let manager = CredentialManager::new()
        .map_err(|e| format!("Failed to access credential manager: {}", e))?;

    manager
        .save_token(&username, &token)
        .map_err(|e| format!("Failed to save token: {}", e))?;

    Ok(())
}

#[derive(Serialize, Deserialize)]
pub struct GitHubCredentials {
    pub username: String,
    pub token: String,
}

#[tauri::command]
pub async fn get_stored_github_credentials() -> Result<Option<GitHubCredentials>, String> {
    let manager = CredentialManager::new()
        .map_err(|e| format!("Failed to access credential manager: {}", e))?;

    match manager.get_stored_credential() {
        Ok(Some((username, token))) => Ok(Some(GitHubCredentials { username, token })),
        Ok(None) => Ok(None),
        Err(e) => Err(format!("Failed to retrieve credentials: {}", e)),
    }
}

#[tauri::command]
pub async fn get_github_token(username: String) -> Result<String, String> {
    let manager = CredentialManager::new()
        .map_err(|e| format!("Failed to access credential manager: {}", e))?;

    manager
        .get_token(&username)
        .map_err(|e| format!("Failed to retrieve token: {}", e))
}

#[tauri::command]
pub async fn has_github_token(username: String) -> Result<bool, String> {
    let manager = CredentialManager::new()
        .map_err(|e| format!("Failed to access credential manager: {}", e))?;

    Ok(manager.has_token(&username))
}

#[tauri::command]
pub async fn verify_github_token(token: String) -> Result<bool, String> {
    let service = get_git_service()?;
    let result = service.verify_github_token(&token)
        .map_err(|e| format!("Failed to verify token: {}", e))?;
    Ok(result.valid)
}

#[tauri::command]
pub async fn scan_directories(
    directories: Vec<String>,
    max_depth: usize,
    exclude_patterns: Vec<String>,
) -> Result<Vec<String>, String> {
    let paths: Vec<PathBuf> = directories.iter().map(PathBuf::from).collect();
    let scanner = RepositoryScanner::new(paths, max_depth, exclude_patterns);

    let repos = scanner.scan();
    let repo_paths: Vec<String> = repos
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    Ok(repo_paths)
}

// Import helpers

fn repo_name_from_path(path: &str) -> String {
    PathBuf::from(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string()
}

/// Import scanned repositories into the saved projects the dashboard loads. A folder
/// that is already a project keeps its id and metadata; only its git status is refreshed.
#[tauri::command]
pub async fn add_repositories(repo_paths: Vec<String>) -> Result<Vec<Repository>, String> {
    let service = get_git_service();
    let mut seen = HashSet::new();
    let mut imports = Vec::new();

    for path in repo_paths {
        let key = project_sync::normalize_path_key(&path);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }

        // Status checks fetch from the remote, so they run before the cache lock is taken.
        let check = match &service {
            Ok(service) => service.check_status(&path).map_err(|e| e.to_string()),
            Err(error) => Err(error.clone()),
        };
        if let Err(error) = &check {
            eprintln!("[Rust] Status check failed while importing {}: {}", path, error);
        }

        imports.push(LocalRepoImport { name: repo_name_from_path(&path), path, check });
    }

    let now = now_rfc3339();
    project_cache::modify_projects(|projects| {
        imports
            .into_iter()
            .map(|import| project_sync::merge_local_import(projects, import, &now))
            .collect::<Vec<_>>()
    })
    .map_err(|e| format!("Failed to save imported projects: {}", e))
}

/// Import the user's GitHub repositories into the saved projects. Repositories that
/// match an existing project's GitHub link (linked or not) are not duplicated.
#[tauri::command]
pub async fn fetch_github_repos(token: String) -> Result<Vec<Repository>, String> {
    let service = get_git_service()?;
    let github_repos = service.list_github_repos(&token)
        .map_err(|e| format!("Failed to fetch GitHub repos: {}", e))?;

    let now = now_rfc3339();
    // Repository pickers list candidates. Only an explicit create/link action persists one.
    let mut candidates = project_cache::load_projects()
        .map_err(|e| format!("Failed to load existing projects: {}", e))?;
    Ok(github_repos.iter()
        .map(|repo| project_sync::merge_github_import(&mut candidates, repo, &now))
        .collect())
}

// ============================================================================
// NEW PROJECT MANAGEMENT COMMANDS
// ============================================================================

/// Load all projects from cache
#[tauri::command]
pub async fn load_projects() -> Result<Vec<Project>, String> {
    project_cache::load_projects()
        .map_err(|e| format!("Failed to load projects: {}", e))
}

/// Create a new project
#[tauri::command]
pub async fn create_project(
    name: String,
    github_owner: Option<String>,
    github_repo: Option<String>,
    github_url: Option<String>,
    local_path: Option<String>,
) -> Result<Project, String> {
    // Generate unique ID
    let id = format!("{}-{}", name.replace(" ", "-").to_lowercase(), chrono::Utc::now().timestamp());

    // Determine project status based on what's configured
    let project_status = match (&github_owner, &local_path) {
        (None, None) => ProjectStatus::NotConfigured,
        (Some(_), None) => ProjectStatus::GithubOnly,
        (None, Some(_)) => ProjectStatus::LocalOnly,
        (Some(_), Some(_)) => ProjectStatus::Ready,
    };

    // Create the project
    let project = Project {
        id: id.clone(),
        name,
        github_owner,
        github_repo,
        github_url,
        local_path,
        project_status,
        git_status: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        last_synced: None,
        // Priority 3 fields
        description: None,
        archived: None,
        favorite: None,
        last_activity: None,
        statistics: None,
        template: None,
        labels: Vec::new(),
    };

    // Save to cache
    project_cache::save_project(project.clone())
        .map_err(|e| format!("Failed to save project: {}", e))?;

    Ok(project)
}

/// Update an existing project
#[tauri::command]
pub async fn update_project(project: Project) -> Result<Project, String> {
    project_cache::save_project(project.clone())
        .map_err(|e| format!("Failed to update project: {}", e))?;

    Ok(project)
}

/// Delete a project
#[tauri::command]
pub async fn delete_project(project_id: String) -> Result<(), String> {
    project_cache::delete_project(&project_id)
        .map_err(|e| format!("Failed to delete project: {}", e))
}

/// Check status for a project with a local repository (GitHub is optional)
#[tauri::command]
pub async fn check_project_status(project_id: String) -> Result<Project, String> {
    refresh_project_status(&project_id)
}

/// Result of editor availability detection
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorAvailability {
    pub vscode: bool,
    pub cursor: bool,
    pub sublime: bool,
}

/// Find the file a command name refers to, the way the user's shell would. Windows searches PATH
/// with PATHEXT. Unix searches the login shell's PATH, then on macOS the editor CLIs inside their
/// app bundles, which are on PATH only after the user installs the shell command.
fn resolve_command(command: &str) -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let path_var = std::env::var_os("PATH").unwrap_or_default();
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        resolve_command_in(command, &path_var, &pathext)
    }

    #[cfg(unix)]
    {
        let found = resolve_command_in(command, crate::login_path::login_path(), "");
        #[cfg(target_os = "macos")]
        let found = found.or_else(|| macos_bundled_command(command));
        found
    }
}

/// An existing path as given, otherwise each PATH directory in turn. Windows also tries each PATHEXT
/// extension; Unix accepts only a regular file with an execute bit.
fn resolve_command_in(command: &str, path_var: &std::ffi::OsStr, pathext: &str) -> Option<std::path::PathBuf> {
    use std::path::{Path, PathBuf};

    let extensions: Vec<&str> = pathext.split(';').filter(|e| !e.is_empty()).collect();
    let with_extensions = |base: PathBuf| -> Option<PathBuf> {
        if runs_as_named(&base) {
            return Some(base);
        }
        extensions.iter().find_map(|ext| {
            let mut name = base.clone().into_os_string();
            name.push(ext);
            let candidate = PathBuf::from(name);
            candidate.is_file().then_some(candidate)
        })
    };

    if Path::new(command).is_absolute() || command.chars().any(std::path::is_separator) {
        return with_extensions(PathBuf::from(command));
    }
    std::env::split_paths(path_var).find_map(|dir| with_extensions(dir.join(command)))
}

#[cfg(not(unix))]
fn runs_as_named(candidate: &std::path::Path) -> bool {
    candidate.extension().is_some() && candidate.is_file()
}

#[cfg(unix)]
fn runs_as_named(candidate: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(candidate).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(target_os = "macos")]
fn macos_bundled_command(command: &str) -> Option<std::path::PathBuf> {
    let inside_bundle = match command {
        "code" => "Visual Studio Code.app/Contents/Resources/app/bin/code",
        "cursor" => "Cursor.app/Contents/Resources/app/bin/cursor",
        "subl" => "Sublime Text.app/Contents/SharedSupport/bin/subl",
        _ => return None,
    };
    let user_apps = dirs::home_dir().map(|home| home.join("Applications"));
    [Some(std::path::PathBuf::from("/Applications")), user_apps]
        .into_iter()
        .flatten()
        .map(|apps| apps.join(inside_bundle))
        .find(|candidate| runs_as_named(candidate))
}

/// Check if a command is available in PATH
fn check_command_available(command: &str) -> bool {
    resolve_command(command).is_some()
}

/// Check if Sublime Text is available (has special path handling)
fn check_sublime_available() -> bool {
    // First check if 'subl' is in PATH
    if check_command_available("subl") {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        // Check common Windows install paths
        let common_paths = [
            r"C:\Program Files\Sublime Text\subl.exe",
            r"C:\Program Files\Sublime Text 3\subl.exe",
            r"C:\Program Files (x86)\Sublime Text\subl.exe",
            r"C:\Program Files (x86)\Sublime Text 3\subl.exe",
        ];
        return common_paths
            .iter()
            .any(|p| std::path::Path::new(p).exists());
    }

    #[cfg(target_os = "linux")]
    {
        // Also check sublime_text command on Linux
        return check_command_available("sublime_text");
    }

    // macOS finds subl inside the app bundle through resolve_command.
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        false
    }
}

/// Detect which editors are installed on the system
#[tauri::command]
pub async fn detect_installed_editors() -> Result<EditorAvailability, String> {
    Ok(EditorAvailability {
        vscode: check_command_available("code"),
        cursor: check_command_available("cursor"),
        sublime: check_sublime_available(),
    })
}

/// Get the command and arguments for an editor preset
fn get_editor_command(
    preset: &str,
    custom_command: Option<&str>,
    path: &str,
) -> Result<(String, Vec<String>), String> {
    match preset {
        "vscode" => Ok(("code".to_string(), vec![path.to_string()])),
        "cursor" => Ok(("cursor".to_string(), vec![path.to_string()])),
        "sublime" => {
            // Try subl first, then check common install paths on Windows
            if check_command_available("subl") {
                return Ok(("subl".to_string(), vec![path.to_string()]));
            }

            #[cfg(target_os = "windows")]
            {
                let common_paths = [
                    r"C:\Program Files\Sublime Text\subl.exe",
                    r"C:\Program Files\Sublime Text 3\subl.exe",
                    r"C:\Program Files (x86)\Sublime Text\subl.exe",
                    r"C:\Program Files (x86)\Sublime Text 3\subl.exe",
                ];
                for p in common_paths {
                    if std::path::Path::new(p).exists() {
                        return Ok((p.to_string(), vec![path.to_string()]));
                    }
                }
            }

            #[cfg(target_os = "linux")]
            {
                if check_command_available("sublime_text") {
                    return Ok(("sublime_text".to_string(), vec![path.to_string()]));
                }
            }

            Err("Sublime Text not found. Please install it or add 'subl' to your PATH.".to_string())
        }
        "custom" => {
            let cmd = custom_command.ok_or("Custom editor command not specified")?;
            if cmd.trim().is_empty() {
                return Err("Custom editor command is empty".to_string());
            }

            // Parse custom command - might include flags (e.g., "nvim --listen")
            let parts: Vec<&str> = cmd.split_whitespace().collect();
            if parts.is_empty() {
                return Err("Invalid custom command".to_string());
            }

            let command = parts[0].to_string();
            let mut args: Vec<String> = parts[1..].iter().map(|s| s.to_string()).collect();
            args.push(path.to_string());

            Ok((command, args))
        }
        _ => Err(format!("Unknown editor preset: {}", preset)),
    }
}

/// Execute an editor command
fn execute_editor_command(command: &str, args: &[String]) -> Result<(), String> {
    use std::process::Command;

    if command.chars().chain(args.iter().flat_map(|a| a.chars())).any(char::is_control) {
        return Err("Editor command contains control characters".to_string());
    }

    // Spawn the resolved file directly: no shell ever sees the command or its arguments.
    let resolved = resolve_command(command).ok_or_else(|| {
        format!(
            "Failed to open editor: '{}' was not found. Make sure it is installed and available in PATH.",
            command
        )
    })?;
    let mut editor = Command::new(&resolved);
    editor.args(args);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        editor.creation_flags(CREATE_NO_WINDOW);
    }

    // Editors start terminals and tools of their own; give them the PATH the user's shell has.
    #[cfg(unix)]
    editor.env("PATH", crate::login_path::login_path());

    editor
        .spawn()
        .map_err(|e| format!("Failed to open editor: {}. Make sure '{}' exists.", e, command))?;

    Ok(())
}

/// Open a directory in the configured editor
#[tauri::command]
pub async fn open_in_editor(
    path: String,
    editor_preset: String,
    custom_command: Option<String>,
) -> Result<(), String> {
    use std::path::Path;

    // Security: Validate path before passing to shell
    let path_obj = Path::new(&path);

    // Check for path traversal attempts
    if path.contains("..") {
        return Err("Invalid path: path traversal not allowed".to_string());
    }

    // Ensure path exists and is a directory
    if !path_obj.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if !path_obj.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    // Canonicalize the path to resolve any remaining issues
    let canonical_path = path_obj
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {}", e))?;

    let mut path_str = canonical_path.to_string_lossy().to_string();

    // On Windows, canonicalize() returns paths with \\?\ prefix which confuses editors
    // Strip this prefix for cleaner paths
    #[cfg(target_os = "windows")]
    {
        if path_str.starts_with(r"\\?\") {
            path_str = path_str[4..].to_string();
        }
    }

    // Get the command for the selected editor
    let (command, args) = get_editor_command(&editor_preset, custom_command.as_deref(), &path_str)?;

    // Execute the editor command
    execute_editor_command(&command, &args)
}

/// Open the project folder in a terminal. The path is passed as an argument, never through a shell.
#[tauri::command]
pub async fn open_in_terminal(path: String) -> Result<(), String> {
    let path = canonical_directory(&path)?;
    spawn_terminal(&path)
}

fn canonical_directory(path: &str) -> Result<String, String> {
    use std::path::Path;

    if path.contains("..") || path.chars().any(char::is_control) {
        return Err("Invalid path".to_string());
    }

    let path_obj = Path::new(path);
    if !path_obj.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !path_obj.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let canonical = path_obj
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {}", e))?;
    let path_str = canonical.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    let path_str = path_str
        .strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or(path_str);

    Ok(path_str)
}

fn spawn_terminal(path: &str) -> Result<(), String> {
    use std::process::Command;

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", "Terminal", path])
            .spawn()
            .map_err(|e| format!("Failed to open Terminal: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        return spawn_windows_terminal(path);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return spawn_unix_terminal(path);
    }
}

#[cfg(target_os = "windows")]
fn spawn_windows_terminal(path: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NEW_CONSOLE: u32 = 0x00000010;
    if resolve_command("wt").is_some() {
        Command::new("wt")
            .args(["-d", path])
            .spawn()
            .map_err(|e| format!("Failed to open Windows Terminal: {}", e))?;
        return Ok(());
    }

    Command::new("cmd")
        .current_dir(path)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map_err(|e| format!("Failed to open Command Prompt: {}", e))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_unix_terminal(path: &str) -> Result<(), String> {
    use std::process::Command;

    let attempts: &[(&str, &[&str])] = &[
        ("gnome-terminal", &["--working-directory"]),
        ("konsole", &["--workdir"]),
        ("xfce4-terminal", &["--working-directory"]),
        ("kitty", &["--directory"]),
        ("alacritty", &["--working-directory"]),
        ("wezterm", &["start", "--cwd"]),
    ];
    for (program, prefix) in attempts {
        if resolve_command(program).is_none() {
            continue;
        }
        let mut args: Vec<String> = prefix.iter().copied().map(str::to_string).collect();
        args.push(path.to_string());
        Command::new(program)
            .args(&args)
            .spawn()
            .map_err(|e| format!("Failed to open {}: {}", program, e))?;
        return Ok(());
    }

    if resolve_command("x-terminal-emulator").is_some() {
        Command::new("x-terminal-emulator")
            .current_dir(path)
            .spawn()
            .map_err(|e| format!("Failed to open a terminal: {}", e))?;
        return Ok(());
    }

    Err("No terminal program was found.".to_string())
}

/// Save editor settings
#[tauri::command]
pub async fn save_editor_settings(
    preset: String,
    custom_command: Option<String>,
) -> Result<(), String> {
    let editor_preset = match preset.as_str() {
        "vscode" => EditorPreset::Vscode,
        "cursor" => EditorPreset::Cursor,
        "sublime" => EditorPreset::Sublime,
        "custom" => EditorPreset::Custom,
        _ => return Err(format!("Unknown editor preset: {}", preset)),
    };

    app_settings::save_editor_config(editor_preset, custom_command)
        .map_err(|e| format!("Failed to save editor settings: {}", e))
}

/// Load editor settings
#[tauri::command]
pub async fn load_editor_settings() -> Result<EditorConfig, String> {
    app_settings::get_editor_config().map_err(|e| format!("Failed to load editor settings: {}", e))
}

/// Clone a GitHub repository to a local directory
#[tauri::command]
pub async fn clone_repository(
    github_url: String,
    local_path: String,
    project_id: String,
) -> Result<Project, String> {
    let service = get_git_service()?;

    // Execute clone operation
    service.clone_repository(&github_url, &local_path)
        .map_err(|e| format!("Failed to clone repository: {}", e))?;

    // Update the stored project with the new local path
    project_cache::update_project(&project_id, |project| {
        project.local_path = Some(local_path);
        project.project_status = ProjectStatus::Ready;
    })
    .map_err(|e| format!("Failed to save project: {}", e))
}

/// Create a new GitHub repository and push local repository to it
#[tauri::command]
pub async fn create_github_repository(
    project_id: String,
    repo_name: String,
    is_private: bool,
    token: String,
) -> Result<Project, String> {
    let service = get_git_service()?;

    let local_path = find_project(&project_id)?
        .local_path
        .ok_or_else(|| "Project has no local path".to_string())?;

    // Create GitHub repository
    let github_url = service.create_github_repository(&token, &repo_name, is_private)
        .map_err(|e| format!("Failed to create GitHub repository: {}", e))?;

    // Parse owner and repo from URL
    let url_parts: Vec<&str> = github_url.trim_end_matches(".git").split('/').collect();
    let github_repo = url_parts.last().map(|s| s.to_string());
    let github_owner = if url_parts.len() >= 2 {
        url_parts.get(url_parts.len() - 2).map(|s| s.to_string())
    } else {
        None
    };

    // Initialize git repo if not already initialized
    service.init_repository(&local_path)
        .map_err(|e| format!("Failed to initialize git repository: {}", e))?;

    // Link the remote. Publishing is a separate action with an explicit file selection.
    service.add_remote(&local_path, "origin", &github_url)
        .map_err(|e| format!("Failed to add remote: {}", e))?;

    // Record the GitHub link on the stored project (re-read under the cache lock: the
    // network calls above are slow and other commands may have edited it meanwhile)
    project_cache::update_project(&project_id, |project| {
        project.github_url = Some(github_url);
        project.github_owner = github_owner;
        project.github_repo = github_repo;
        project.project_status = ProjectStatus::Ready;
    })
    .map_err(|e| format!("Failed to save project: {}", e))
}

/// Validate files before sync to prevent push failures
/// Checks for large files (>100MB GitHub limit) and problematic patterns
#[tauri::command]
pub async fn validate_before_sync(project_id: String, selected_files: Option<Vec<String>>) -> Result<PreSyncValidation, String> {
    let projects = project_cache::load_projects()
        .map_err(|e| format!("Failed to load projects: {}", e))?;

    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("Project not found: {}", project_id))?;

    let local_path = project
        .local_path
        .as_ref()
        .ok_or_else(|| "Project has no local path".to_string())?;

    let service = get_git_service()?;
    let validation = service
        .validate_before_sync(local_path, selected_files)
        .map_err(|e| format!("Validation failed: {}", e))?;

    Ok(validation)
}

/// Sync a project (replacement for sync_repository that works with projects)
#[tauri::command]
pub async fn sync_project(project_id: String, action: SyncAction) -> Result<SyncResult, String> {
    run_sync(&project_id, action)
}

// ==================== ADVANCED GIT FEATURES ====================

#[tauri::command]
pub async fn git_get_branches(repo_path: String) -> Result<Vec<BranchInfo>, String> {
    let service = get_git_service()?;
    service.get_branches(&repo_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_create_branch(repo_path: String, branch_name: String, checkout: bool) -> Result<(), String> {
    let service = get_git_service()?;
    service.create_branch(&repo_path, &branch_name, checkout)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_switch_branch(repo_path: String, branch_name: String) -> Result<(), String> {
    let service = get_git_service()?;
    service.switch_branch(&repo_path, &branch_name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_delete_branch(repo_path: String, branch_name: String, force: bool) -> Result<(), String> {
    let service = get_git_service()?;
    service.delete_branch(&repo_path, &branch_name, force)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_get_commit_history(repo_path: String, limit: u32) -> Result<Vec<CommitInfo>, String> {
    let service = get_git_service()?;
    service.get_commit_history(&repo_path, limit)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_get_diff(repo_path: String, file_path: Option<String>, scope: Option<String>) -> Result<Vec<DiffInfo>, String> {
    let service = get_git_service()?;
    service.get_diff(&repo_path, file_path, scope)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_get_file_changes(repo_path: String) -> Result<Vec<FileChangeInfo>, String> {
    get_git_service()?.get_file_changes(&repo_path)
        .map_err(|e| format!("Failed to get changed files: {}", e))
}

#[tauri::command]
pub async fn git_create_stash(repo_path: String, message: Option<String>) -> Result<(), String> {
    let service = get_git_service()?;
    service.create_stash(&repo_path, message)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_list_stashes(repo_path: String) -> Result<Vec<StashInfo>, String> {
    let service = get_git_service()?;
    service.list_stashes(&repo_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_apply_stash(repo_path: String, index: u32) -> Result<(), String> {
    let service = get_git_service()?;
    service.apply_stash(&repo_path, index)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_pop_stash(repo_path: String) -> Result<(), String> {
    let service = get_git_service()?;
    service.pop_stash(&repo_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_drop_stash(repo_path: String, index: u32) -> Result<(), String> {
    let service = get_git_service()?;
    service.drop_stash(&repo_path, index)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_create_tag(repo_path: String, tag_name: String, message: Option<String>) -> Result<(), String> {
    let service = get_git_service()?;
    service.create_tag(&repo_path, &tag_name, message)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_list_tags(repo_path: String) -> Result<Vec<TagInfo>, String> {
    let service = get_git_service()?;
    service.list_tags(&repo_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_push_tag(repo_path: String, tag_name: String) -> Result<(), String> {
    let service = get_git_service()?;
    service.push_tag(&repo_path, &tag_name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_push_all_tags(repo_path: String) -> Result<(), String> {
    let service = get_git_service()?;
    service.push_all_tags(&repo_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_delete_tag(repo_path: String, tag_name: String) -> Result<(), String> {
    let service = get_git_service()?;
    service.delete_tag(&repo_path, &tag_name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_cherry_pick(repo_path: String, commit_hash: String) -> Result<(), String> {
    let service = get_git_service()?;
    service.cherry_pick(&repo_path, &commit_hash)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_get_current_branch(repo_path: String) -> Result<String, String> {
    let service = get_git_service()?;
    service.get_current_branch(&repo_path)
        .map_err(|e| e.to_string())
}

// ==================== PROJECT MANAGEMENT (PRIORITY 3) ====================
//
// Each command edits the stored project in place (`update_project`) so a slow
// operation elsewhere cannot overwrite these fields with a stale copy.

/// Update project metadata (description, favorite, archived)
#[tauri::command]
pub async fn update_project_metadata(
    project_id: String,
    description: Option<String>,
    favorite: Option<bool>,
    archived: Option<bool>,
) -> Result<Project, String> {
    project_cache::update_project(&project_id, |project| {
        // Update fields if provided
        if description.is_some() {
            project.description = description;
        }
        if favorite.is_some() {
            project.favorite = favorite;
        }
        if archived.is_some() {
            project.archived = archived;
        }

        // Update last activity
        project.last_activity = Some(now_rfc3339());
    })
    .map_err(|e| format!("Failed to save project: {}", e))
}

/// Toggle project favorite status
#[tauri::command]
pub async fn toggle_project_favorite(project_id: String) -> Result<Project, String> {
    project_cache::update_project(&project_id, |project| {
        project.favorite = Some(!project.favorite.unwrap_or(false));
        project.last_activity = Some(now_rfc3339());
    })
    .map_err(|e| format!("Failed to save project: {}", e))
}

/// Replace a project's labels. Invalid input is rejected and the stored list is left as it was.
#[tauri::command]
pub async fn set_project_labels(project_id: String, labels: Vec<String>) -> Result<Project, String> {
    let normalized = normalize_labels(&labels)?;
    project_cache::update_project(&project_id, |project| {
        project.labels = normalized;
    })
    .map_err(|e| format!("Failed to save project: {}", e))
}

/// Toggle project archived status
#[tauri::command]
pub async fn toggle_project_archived(project_id: String) -> Result<Project, String> {
    project_cache::update_project(&project_id, |project| {
        project.archived = Some(!project.archived.unwrap_or(false));
        project.last_activity = Some(now_rfc3339());
    })
    .map_err(|e| format!("Failed to save project: {}", e))
}

/// Drop the `Cargo.lock` ignore rule from a Rust template: application lockfiles stay
/// tracked so saved history can reproduce the dependency set. Other lines are kept
/// byte-for-byte. The rule is defined in the UI's template list (`src/types/index.ts`);
/// remove it there and this guard becomes a no-op.
fn keep_cargo_lock_tracked(template_id: &str, gitignore: &str) -> String {
    if template_id != "rust" {
        return gitignore.to_string();
    }
    gitignore
        .split_inclusive('\n')
        .filter(|line| !matches!(line.trim(), "Cargo.lock" | "/Cargo.lock"))
        .collect()
}

/// Append reviewed ignore patterns to the saved project's root file.
#[tauri::command]
pub fn add_gitignore_patterns(project_id: String, patterns: Vec<String>) -> Result<usize, String> {
    let project = find_project(&project_id)?;
    let local_path = project.local_path.as_deref().ok_or("Project has no local path")?;
    crate::gitignore::append_patterns(std::path::Path::new(local_path), &patterns)
}

/// Apply a template to a project (write .gitignore and other files)
#[tauri::command]
pub async fn apply_project_template(
    project_id: String,
    template_id: String,
    gitignore_content: String,
) -> Result<Project, String> {
    use std::fs;
    use std::path::Path;

    let project = find_project(&project_id)?;

    // Check if local path exists
    let local_path = project.local_path
        .as_ref()
        .ok_or_else(|| "Project has no local path".to_string())?;

    // Existing rules remain last so their explicit exceptions still override template defaults.
    if !gitignore_content.is_empty() {
        let gitignore_path = Path::new(local_path).join(".gitignore");
        if fs::symlink_metadata(&gitignore_path).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            return Err("The .gitignore file is a link; edit it explicitly before applying a template".to_string());
        }
        let existing = match fs::read_to_string(&gitignore_path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(format!("Failed to read existing .gitignore: {}", error)),
        };
        let proposed = keep_cargo_lock_tracked(&template_id, &gitignore_content);
        let existing_lines: HashSet<&str> = existing.lines().map(str::trim).collect();
        let additions: Vec<&str> = proposed.lines().filter(|line| !line.trim().is_empty() && !existing_lines.contains(line.trim())).collect();
        let combined = if additions.is_empty() { existing } else { format!("{}\n{}", additions.join("\n"), existing) };
        fs::write(&gitignore_path, combined)
            .map_err(|e| format!("Failed to write .gitignore: {}", e))?;
    }

    // Update project template
    project_cache::update_project(&project_id, |project| {
        project.template = Some(template_id);
        project.last_activity = Some(now_rfc3339());
    })
    .map_err(|e| format!("Failed to save project: {}", e))
}

/// Increment project statistics
#[tauri::command]
pub async fn increment_project_stats(
    project_id: String,
    stat_type: String,
) -> Result<Project, String> {
    if !["sync", "commit", "push", "merge", "pull"].contains(&stat_type.as_str()) {
        return Err(format!("Unknown stat type: {}", stat_type));
    }

    project_cache::update_project(&project_id, |project| {
        let now = now_rfc3339();

        // Initialize statistics if not present
        let stats = project.statistics.get_or_insert_with(|| ProjectStatistics {
            total_syncs: 0,
            total_commits: 0,
            total_pushes: 0,
            total_merges: 0,
            total_pulls: 0,
            last_sync_date: None,
            last_commit_date: None,
        });

        match stat_type.as_str() {
            "sync" => {
                stats.total_syncs += 1;
                stats.last_sync_date = Some(now.clone());
            }
            "commit" => {
                stats.total_commits += 1;
                stats.last_commit_date = Some(now.clone());
            }
            "push" => stats.total_pushes += 1,
            "merge" => stats.total_merges += 1,
            "pull" => stats.total_pulls += 1,
            _ => {} // rejected before the update
        }

        project.last_activity = Some(now);
    })
    .map_err(|e| format!("Failed to save project: {}", e))
}

// ==================== RECOVERY ====================

/// Read the stored GitHub token for a remote recovery action. It travels inside that one
/// request, so a recovery for another project cannot change it, and it is never logged or
/// persisted here. The caller redacts it from error text. Local recovery works without one.
fn read_stored_token() -> Option<String> {
    let manager = match CredentialManager::new() {
        Ok(manager) => manager,
        Err(e) => {
            eprintln!("[Rust] Recovery continues without a GitHub token: {}", e);
            return None;
        }
    };

    match manager.get_stored_credential() {
        Ok(Some((_, token))) => Some(token),
        Ok(None) => None,
        Err(e) => {
            eprintln!("[Rust] Recovery continues without a GitHub token: {}", e);
            None
        }
    }
}

/// Forward a recovery request for a saved project to the Git service, which owns the
/// vault, destinations and receipts. The request must name a recognised action with
/// only its documented fields; the source path comes from the saved project, never the
/// caller. The source need not exist, so old checkpoints of a deleted project stay usable.
#[tauri::command]
pub async fn recovery_command(
    project_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request = recovery_request::validate_recovery_request(request)?;

    let repo_path = find_project(&project_id)?
        .local_path
        .ok_or_else(|| "Project has no local path".to_string())?;
    recovery_request::validate_repo_path(&repo_path)?;

    // The service call blocks its thread until the response arrives, which can take minutes,
    // so run it off the async runtime's worker threads.
    tauri::async_runtime::spawn_blocking(move || {
        // Checks can run for ten minutes. A scoped service keeps other projects available;
        // the vault's cross-process lock still serializes operations on this same project.
        // GitService::drop stops and waits for its owned Node child on every return path.
        let service = if request.runs_check() {
            Arc::new(GitService::new().map_err(|e| format!("Could not start the check service: {}", e))?)
        } else { get_git_service()? };
        let token = if request.needs_remote() { read_stored_token() } else { None };

        service.recovery(&repo_path, request.into_request(), token.as_deref()).map_err(|e| {
            let message = format!("Recovery failed: {}", e);
            match &token {
                Some(token) => recovery_request::redact_secret(&message, token),
                None => message,
            }
        })
    })
    .await
    .map_err(|e| format!("Recovery task failed: {}", e))?
}

// ==================== ANALYTICS FEATURES ====================

/// Simplified analytics data structures for Tauri commands
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsData {
    pub overview: DashboardOverview,
    pub timeline: ActivityTimeline,
    pub health: Vec<HealthIndicator>,
    pub heatmap: ContributionHeatmap,
    pub last_updated: String,
    pub generated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DashboardOverview {
    pub total_projects: usize,
    pub active_projects: usize,
    pub needs_attention: usize,
    pub commits_today: u32,
    pub commits_this_week: u32,
    pub commits_this_month: u32,
    pub total_branches: u32,
    pub total_stashes: u32,
    pub total_tags: u32,
    pub most_active_project: Option<MostActiveProject>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MostActiveProject {
    pub id: String,
    pub name: String,
    pub commit_count: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActivityTimeline {
    pub entries: Vec<ActivityEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    pub project_color: String,
    pub commit_hash: String,
    pub commit_message: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub branch: String,
    pub files_changed: u32,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HealthIndicator {
    pub project_id: String,
    pub project_name: String,
    pub days_since_last_commit: Option<i32>,
    pub uncommitted_changes_duration: Option<i32>,
    pub stale_branches: Vec<StaleBranchInfo>,
    pub health_status: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StaleBranchInfo {
    pub name: String,
    pub days_since_last_commit: i32,
    pub is_remote: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContributionHeatmap {
    pub daily_contributions: HashMap<String, DailyContribution>,
    pub start_date: String,
    pub end_date: String,
    pub total_contributions: u32,
    pub current_streak: u32,
    pub longest_streak: u32,
    pub most_productive_day: Option<MostProductiveDay>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DailyContribution {
    pub date: String,
    pub count: u32,
    pub projects: Vec<String>,
    pub level: u8,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MostProductiveDay {
    pub date: String,
    pub count: u32,
}

const ANALYTICS_HISTORY_DAYS: i64 = 90;
const ANALYTICS_RECENT_DAYS: i64 = 30;
const ANALYTICS_RECENT_COMMITS: u32 = 30; // per project
const ANALYTICS_TIMELINE_ENTRIES: usize = 50;

/// Generate analytics for all projects from one batched service request
#[tauri::command]
pub async fn generate_analytics() -> Result<AnalyticsData, String> {
    use chrono::{Duration, Local, Utc};

    let projects = project_cache::load_projects()
        .map_err(|e| format!("Failed to load projects: {}", e))?;

    let now = Utc::now();
    let today_start = now.date_naive().and_hms_opt(0, 0, 0).unwrap();
    let week_start = today_start - Duration::days(7);
    let month_start = today_start - Duration::days(30);
    // Heatmap days are the author's calendar days, so its window follows the local date.
    let today = Local::now().date_naive();
    let history_start = today - Duration::days(ANALYTICS_HISTORY_DAYS);
    let history_since = history_start.format("%Y-%m-%d").to_string();
    let recent_since = (today - Duration::days(ANALYTICS_RECENT_DAYS)).format("%Y-%m-%d").to_string();

    let repo_paths: Vec<&str> = projects.iter().filter_map(|p| p.local_path.as_deref()).collect();
    let results = get_git_service()?
        .get_analytics_snapshots(&repo_paths, &history_since, &recent_since, ANALYTICS_RECENT_COMMITS)
        .map_err(|e| format!("Failed to read project history: {}", e))?;
    let results: HashMap<&str, &AnalyticsSnapshotResult> =
        results.iter().map(|r| (r.repo_path.as_str(), r)).collect();

    let mut overview = DashboardOverview {
        total_projects: projects.len(),
        active_projects: 0,
        needs_attention: 0,
        commits_today: 0,
        commits_this_week: 0,
        commits_this_month: 0,
        total_branches: 0,
        total_stashes: 0,
        total_tags: 0,
        most_active_project: None,
    };
    let mut timeline_entries: Vec<ActivityEntry> = Vec::new();
    let mut health: Vec<HealthIndicator> = Vec::new();
    let mut daily_contributions: HashMap<String, DailyContribution> = HashMap::new();

    for (idx, project) in projects.iter().enumerate() {
        let local_path = match &project.local_path {
            Some(path) => path,
            None => continue,
        };

        if let Some(last_synced) = &project.last_synced {
            if let Ok(last_sync_time) = chrono::DateTime::parse_from_rfc3339(last_synced) {
                if (now - last_sync_time.with_timezone(&Utc)).num_days() <= 7 {
                    overview.active_projects += 1;
                }
            }
        }

        if let Some(git_status) = &project.git_status {
            if git_status.uncommitted_files > 0 || !git_status.remote_branches.is_empty() {
                overview.needs_attention += 1;
            }
        }

        let result = results.get(local_path.as_str()).copied();
        health.push(project_health(project, result));

        let snapshot = match result.and_then(|r| r.snapshot.as_ref()) {
            Some(snapshot) => snapshot,
            None => continue,
        };

        overview.total_branches += snapshot.branches.len() as u32;
        overview.total_stashes += snapshot.stash_count;
        overview.total_tags += snapshot.tag_count;

        let commit_count = snapshot.commit_dates.len() as u32;
        if overview.most_active_project.as_ref().map_or(true, |p| commit_count > p.commit_count) {
            overview.most_active_project = Some(MostActiveProject {
                id: project.id.clone(),
                name: project.name.clone(),
                commit_count,
            });
        }

        for date in &snapshot.commit_dates {
            if let Ok(commit_date) = chrono::DateTime::parse_from_rfc3339(date) {
                let commit_date = commit_date.naive_utc();
                if commit_date >= today_start {
                    overview.commits_today += 1;
                }
                if commit_date >= week_start {
                    overview.commits_this_week += 1;
                }
                if commit_date >= month_start {
                    overview.commits_this_month += 1;
                }
            }

            let date_key = date.split('T').next().unwrap_or(date).to_string();
            let entry = daily_contributions.entry(date_key.clone()).or_insert(DailyContribution {
                date: date_key,
                count: 0,
                projects: Vec::new(),
                level: 0,
            });
            entry.count += 1;
            if !entry.projects.contains(&project.id) {
                entry.projects.push(project.id.clone());
            }
        }

        for commit in &snapshot.recent_commits {
            timeline_entries.push(ActivityEntry {
                id: format!("{}-{}", project.id, commit.hash),
                project_id: project.id.clone(),
                project_name: project.name.clone(),
                project_color: format!("hsl({}, 70%, 50%)", (idx * 137) % 360),
                commit_hash: commit.hash.clone(),
                commit_message: commit.message.clone(),
                author: commit.author.clone(),
                email: commit.email.clone(),
                date: commit.date.clone(),
                branch: commit.branch.clone(),
                files_changed: commit.files_changed,
                additions: commit.additions,
                deletions: commit.deletions,
            });
        }
    }

    timeline_entries.sort_by(|a, b| b.date.cmp(&a.date));
    timeline_entries.truncate(ANALYTICS_TIMELINE_ENTRIES);

    Ok(AnalyticsData {
        overview,
        timeline: ActivityTimeline { entries: timeline_entries },
        health,
        heatmap: build_heatmap(daily_contributions, history_start, today),
        last_updated: now.to_rfc3339(),
        generated_at: now.to_rfc3339(),
    })
}

fn project_health(project: &Project, result: Option<&AnalyticsSnapshotResult>) -> HealthIndicator {
    let snapshot = result.and_then(|r| r.snapshot.as_ref());
    let days_since_last_commit = snapshot.and_then(|s| s.days_since_last_commit);

    let mut warnings = Vec::new();
    let health_status = if let Some(error) = result.and_then(|r| r.error.as_ref()) {
        warnings.push(format!("Could not read repository: {}", error));
        "attention"
    } else if let Some(days) = days_since_last_commit {
        if days > 7 {
            warnings.push(format!("No commits in {} days", days));
        }
        if days > 30 {
            "critical"
        } else if days > 14 {
            "warning"
        } else if days > 7 {
            "attention"
        } else {
            "healthy"
        }
    } else {
        warnings.push("No commits found".to_string());
        "attention"
    };

    let uncommitted_files = project.git_status.as_ref().map_or(0, |s| s.uncommitted_files);
    let uncommitted_changes_duration = if uncommitted_files > 0 {
        warnings.push(format!("{} uncommitted files", uncommitted_files));
        Some(24)
    } else {
        None
    };

    let stale_branches: Vec<StaleBranchInfo> = snapshot
        .map(|s| s.branches.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|b| b.days_since_last_commit > 30)
        .map(|b| StaleBranchInfo {
            name: b.name.clone(),
            days_since_last_commit: b.days_since_last_commit,
            is_remote: b.is_remote,
        })
        .collect();
    if !stale_branches.is_empty() {
        warnings.push(format!("{} stale branches", stale_branches.len()));
    }

    HealthIndicator {
        project_id: project.id.clone(),
        project_name: project.name.clone(),
        days_since_last_commit,
        uncommitted_changes_duration,
        stale_branches,
        health_status: health_status.to_string(),
        warnings,
    }
}

fn build_heatmap(
    mut daily_contributions: HashMap<String, DailyContribution>,
    start: chrono::NaiveDate,
    today: chrono::NaiveDate,
) -> ContributionHeatmap {
    let max_commits = daily_contributions.values().map(|d| d.count).max().unwrap_or(1);
    for contrib in daily_contributions.values_mut() {
        let ratio = contrib.count as f32 / max_commits as f32;
        contrib.level = if contrib.count == 0 {
            0
        } else if ratio < 0.25 {
            1
        } else if ratio < 0.5 {
            2
        } else if ratio < 0.75 {
            3
        } else {
            4
        };
    }

    let mut current_streak = 0u32;
    let mut longest_streak = 0u32;
    let mut run = 0u32;
    let mut days_back = 0u32;
    let mut date = today;
    while date >= start {
        days_back += 1;
        if daily_contributions.contains_key(&date.format("%Y-%m-%d").to_string()) {
            run += 1;
            longest_streak = longest_streak.max(run);
            // Only a run with no gap since today is the current streak.
            if run == days_back {
                current_streak = run;
            }
        } else {
            run = 0;
        }
        date = match date.pred_opt() {
            Some(previous) => previous,
            None => break,
        };
    }

    let most_productive_day = daily_contributions
        .values()
        .max_by_key(|d| d.count)
        .map(|d| MostProductiveDay {
            date: d.date.clone(),
            count: d.count,
        });
    let total_contributions = daily_contributions.values().map(|d| d.count).sum();

    ContributionHeatmap {
        daily_contributions,
        start_date: start.format("%Y-%m-%d").to_string(),
        end_date: today.format("%Y-%m-%d").to_string(),
        total_contributions,
        current_streak,
        longest_streak,
        most_productive_day,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_command_resolves_through_path_and_pathext_without_a_shell() {
        let dir = std::env::temp_dir().join(format!("bitgit-editor-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fake-editor.cmd"), "").unwrap();
        let path_var = std::env::join_paths([&dir]).unwrap();

        let found = resolve_command_in("fake-editor", &path_var, ".exe;.cmd");
        assert_eq!(found, Some(dir.join("fake-editor.cmd")));
        assert_eq!(resolve_command_in("missing & calc", &path_var, ".exe;.cmd"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unix_commands_resolve_only_to_executable_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("bitgit-unix-editor-{}", std::process::id()));
        let (first, second) = (dir.join("first"), dir.join("second"));
        std::fs::create_dir_all(first.join("folder")).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        for (file, mode) in [(first.join("editor"), 0o644), (second.join("editor"), 0o755)] {
            std::fs::write(&file, "").unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        let path_var = std::env::join_paths([&first, &second]).unwrap();

        assert_eq!(resolve_command_in("editor", &path_var, ""), Some(second.join("editor")));
        assert_eq!(resolve_command_in("folder", &path_var, ""), None);
        assert_eq!(resolve_command_in(first.join("editor").to_str().unwrap(), &path_var, ""), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn editor_launch_rejects_control_characters() {
        let err = execute_editor_command("code", &["a\nb".to_string()]).unwrap_err();
        assert!(err.contains("control characters"));
        assert!(execute_editor_command("co\0de", &[]).is_err());
    }

    const RUST_TEMPLATE: &str ="# Cargo\n/target/\nCargo.lock\n\n# IDE\n.vscode/\n";

    #[test]
    fn rust_template_keeps_cargo_lock_tracked() {
        let written = keep_cargo_lock_tracked("rust", RUST_TEMPLATE);
        assert_eq!(written, "# Cargo\n/target/\n\n# IDE\n.vscode/\n");
        assert!(!written.lines().any(|line| line.contains("Cargo.lock")));
    }

    #[test]
    fn cargo_lock_guard_preserves_line_endings_and_other_rules() {
        let written = keep_cargo_lock_tracked("rust", "/target/\r\n/Cargo.lock\r\n*.swp\r\n");
        assert_eq!(written, "/target/\r\n*.swp\r\n");

        // A rule that merely mentions the name in a comment or a longer path is not touched.
        let unrelated = "# Cargo.lock stays\nvendor/Cargo.lock\n";
        assert_eq!(keep_cargo_lock_tracked("rust", unrelated), unrelated);
    }

    #[test]
    fn other_templates_are_written_unchanged() {
        assert_eq!(keep_cargo_lock_tracked("node", RUST_TEMPLATE), RUST_TEMPLATE);
        assert_eq!(keep_cargo_lock_tracked("rust", ""), "");
    }

    fn day(date: &str) -> chrono::NaiveDate {
        chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap()
    }

    fn contributions(days: &[(&str, u32)]) -> HashMap<String, DailyContribution> {
        days.iter()
            .map(|(date, count)| {
                (date.to_string(), DailyContribution { date: date.to_string(), count: *count, projects: Vec::new(), level: 0 })
            })
            .collect()
    }

    #[test]
    fn current_streak_is_the_run_that_reaches_today() {
        let days = [("2026-03-10", 1), ("2026-03-09", 2), ("2026-03-07", 1), ("2026-03-06", 1), ("2026-03-05", 1)];
        let heatmap = build_heatmap(contributions(&days), day("2026-01-01"), day("2026-03-10"));
        assert_eq!((heatmap.current_streak, heatmap.longest_streak), (2, 3));
        assert_eq!(heatmap.total_contributions, 6);

        // Without a commit today there is no current streak, whatever happened earlier.
        let heatmap = build_heatmap(contributions(&days), day("2026-01-01"), day("2026-03-11"));
        assert_eq!((heatmap.current_streak, heatmap.longest_streak), (0, 3));
    }

    #[test]
    fn heatmap_levels_scale_to_the_busiest_day() {
        let heatmap = build_heatmap(
            contributions(&[("2026-03-10", 8), ("2026-03-09", 5), ("2026-03-08", 3), ("2026-03-07", 1)]),
            day("2026-01-01"),
            day("2026-03-10"),
        );
        let level = |date: &str| heatmap.daily_contributions[date].level;
        assert_eq!((level("2026-03-10"), level("2026-03-09"), level("2026-03-08"), level("2026-03-07")), (4, 3, 2, 1));
        assert_eq!(heatmap.most_productive_day.map(|d| (d.date, d.count)), Some(("2026-03-10".to_string(), 8)));
    }

    fn health_of(snapshot_result: serde_json::Value) -> HealthIndicator {
        let project: Project = serde_json::from_value(serde_json::json!({
            "id": "p1", "name": "Project", "localPath": "C:\\repo", "projectStatus": "ready", "createdAt": "2026-01-01T00:00:00Z"
        }))
        .unwrap();
        let result: AnalyticsSnapshotResult = serde_json::from_value(snapshot_result).unwrap();
        project_health(&project, Some(&result))
    }

    fn snapshot_with(days_since_last_commit: Option<i32>, branches: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "repoPath": "C:\\repo", "snapshot": {
            "commitDates": [], "recentCommits": [], "branches": branches,
            "daysSinceLastCommit": days_since_last_commit, "tagCount": 0, "stashCount": 0
        }})
    }

    #[test]
    fn health_status_follows_days_since_the_last_commit() {
        let status = |days| health_of(snapshot_with(days, serde_json::json!([]))).health_status;
        assert_eq!(status(Some(7)), "healthy");
        assert_eq!(status(Some(8)), "attention");
        assert_eq!(status(Some(15)), "warning");
        assert_eq!(status(Some(31)), "critical");
        assert_eq!(status(None), "attention");
    }

    #[test]
    fn health_lists_only_branches_stale_for_over_thirty_days() {
        let branch = |name: &str, days: i32| serde_json::json!({
            "name": name, "daysSinceLastCommit": days, "isRemote": false, "lastCommitHash": "abc", "lastCommitDate": "2026-01-01T00:00:00Z"
        });
        let health = health_of(snapshot_with(Some(0), serde_json::json!([branch("fresh", 30), branch("old", 31)])));
        assert_eq!(health.stale_branches.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), vec!["old"]);
        assert_eq!(health.warnings, vec!["1 stale branches"]);
    }

    #[test]
    fn an_unreadable_repository_is_reported_not_hidden() {
        let health = health_of(serde_json::json!({ "repoPath": "C:\\repo", "error": "git log timed out after 30s" }));
        assert_eq!(health.health_status, "attention");
        assert_eq!(health.warnings, vec!["Could not read repository: git log timed out after 30s"]);
    }
}
