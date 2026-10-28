use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Serialize, Deserialize)]
struct IPCCommand {
    id: String,
    #[serde(rename = "type")]
    command_type: String,
    payload: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
struct IPCResponse {
    id: String,
    success: bool,
    data: Option<serde_json::Value>,
    error: Option<String>,
}

// A wedged service must not hold its caller forever. Pushes and recovery checks may legitimately run for
// ten minutes and clones have no ceiling, so this is a backstop, not a responsiveness control.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

const MIN_NODE_MAJOR: u32 = 20;

// macOS and Linux bundles keep resources away from the binary (`Contents/Resources`,
// `/usr/lib/<package>`, `$APPDIR/usr/lib/<package>`), so the app records Tauri's resolved path at setup.
#[cfg(not(windows))]
static BUNDLED_SCRIPT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

#[cfg(not(windows))]
pub fn set_bundled_script(script: PathBuf) {
    // Setup runs once per process, so the slot is always empty here.
    let _ = BUNDLED_SCRIPT.set(script);
}

fn service_script() -> Result<PathBuf> {
    if cfg!(debug_assertions) {
        // Development mode: running from src-tauri directory
        return Ok(PathBuf::from("../git-service/dist/index.js"));
    }
    #[cfg(windows)]
    {
        // Production mode: Tauri bundles resources in _up_ directory
        let exe_dir = std::env::current_exe()
            .context("Failed to get executable path")?
            .parent()
            .context("Failed to get executable directory")?
            .to_path_buf();
        Ok(exe_dir.join("_up_").join("git-service").join("dist").join("index.js"))
    }
    #[cfg(not(windows))]
    {
        BUNDLED_SCRIPT.get().cloned().context("The Git service script was not found in the app bundle")
    }
}

/// Names the Node.js that PATH reaches and its version, so a missing or too old Node reads as such
/// instead of as a service crash.
#[cfg_attr(windows, allow(dead_code))]
fn describe_node(program: &OsStr, path: &OsStr) -> String {
    let probe = Command::new(program)
        .args(["-p", "process.version + ' ' + process.execPath"])
        .env("PATH", path)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    match probe {
        Ok(output) => describe_node_probe(&String::from_utf8_lossy(&output.stdout)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("[Rust] node is not on PATH {}", path.to_string_lossy());
            format!("Node.js was not found on your login shell's PATH. Install Node.js {MIN_NODE_MAJOR} or later.")
        }
        Err(error) => format!("Node.js could not be run ({error}). BitGit needs Node.js {MIN_NODE_MAJOR} or later."),
    }
}

/// Reads `node -p "process.version + ' ' + process.execPath"` output, e.g. `v20.19.2 /usr/bin/node`.
#[cfg_attr(windows, allow(dead_code))]
fn describe_node_probe(output: &str) -> String {
    let (version, node_path) = output.trim().split_once(' ').unwrap_or((output.trim(), "an unknown path"));
    let major = version.strip_prefix('v').and_then(|v| v.split('.').next()).and_then(|v| v.parse::<u32>().ok());
    match major {
        Some(major) if major >= MIN_NODE_MAJOR => format!("It ran Node.js {version} at {node_path}."),
        Some(_) => format!("Node.js {version} at {node_path} is too old: BitGit needs Node.js {MIN_NODE_MAJOR} or later."),
        None => format!("Node.js did not report its version. BitGit needs Node.js {MIN_NODE_MAJOR} or later."),
    }
}

// The guarded sections cannot leave their data half-updated, so a poisoned lock is still usable.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Default)]
struct Waiters {
    by_id: HashMap<String, Sender<IPCResponse>>,
    closed: bool, // the reader saw the service's output end; nothing registered later would ever be answered
}

/// One running service process. Dropping it stops the process and waits for it.
struct Connection {
    child: Child,
    stdin: ChildStdin,
    waiters: Arc<Mutex<Waiters>>,
}

impl Connection {
    fn is_dead(&mut self) -> bool {
        lock(&self.waiters).closed || self.child.try_wait().map(|status| status.is_some()).unwrap_or(true)
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        eprintln!("[Rust] Shutting down Git service");
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// Responses are matched to callers by id, so the service may answer in any order and a line that is
// not a response cannot shift every later caller onto the wrong answer.
fn read_responses(mut reader: BufReader<ChildStdout>, waiters: Arc<Mutex<Waiters>>) {
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        match serde_json::from_str::<IPCResponse>(&line) {
            Ok(response) => {
                if let Some(waiter) = lock(&waiters).by_id.remove(&response.id) {
                    // The caller may have timed out and gone; its response is then dropped.
                    let _ = waiter.send(response);
                }
            }
            // The content is not logged: a response may carry sensitive data.
            Err(_) => eprintln!("[Rust] Ignored {} bytes of unrecognised Git service output", line.len()),
        }
    }
    // Dropping the senders wakes every caller still waiting on this connection.
    let mut waiters = lock(&waiters);
    waiters.closed = true;
    waiters.by_id.clear();
}

/// Requests to the service run concurrently; the service orders the ones that share a repository.
/// A service that has exited is restarted by the next request.
pub struct GitService {
    program: OsString,
    args: Vec<OsString>,
    response_timeout: Duration,
    connection: Mutex<Option<Connection>>,
    command_counter: AtomicU64,
}

impl GitService {
    pub fn new() -> Result<Self> {
        let git_service_path = service_script()?;

        eprintln!("[Rust] Starting Git service from: {}", git_service_path.display());

        let service = Self::with_launch("node".into(), vec![git_service_path.into_os_string()], RESPONSE_TIMEOUT);
        // Connect now so a missing Node.js or service bundle is reported at startup, not on first use.
        let connection = service.connect()?;
        *lock(&service.connection) = Some(connection);
        eprintln!("[Rust] Git service started successfully");
        Ok(service)
    }

    fn with_launch(program: OsString, args: Vec<OsString>, response_timeout: Duration) -> Self {
        Self {
            program,
            args,
            response_timeout,
            connection: Mutex::new(None),
            command_counter: AtomicU64::new(0),
        }
    }

    fn connect(&self) -> Result<Connection> {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        // On Windows, hide the console window for the Node.js process
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        // Also the PATH `node` is looked up on, and the one the service runs `git` with.
        #[cfg(unix)]
        cmd.env("PATH", crate::login_path::login_path());

        let mut child = cmd.spawn().with_context(|| match self.node_report() {
            Some(report) => format!("Failed to spawn Git service process. {report}"),
            None => "Failed to spawn Git service process. Ensure Node.js is installed.".to_string(),
        })?;

        let handshake = (|| -> Result<(ChildStdin, BufReader<ChildStdout>)> {
            let mut stdin = child.stdin.take().context("Failed to access stdin")?;
            let mut reader = BufReader::new(child.stdout.take().context("Failed to access stdout")?);
            let ping = IPCCommand {
                id: "init".to_string(),
                command_type: "ping".to_string(),
                payload: serde_json::json!({}),
            };
            writeln!(stdin, "{}", serde_json::to_string(&ping)?)?;
            stdin.flush()?;
            let mut line = String::new();
            if reader.read_line(&mut line)? == 0 {
                anyhow::bail!("it exited before answering");
            }
            Ok((stdin, reader))
        })();

        let (stdin, reader) = match handshake {
            Ok(pipes) => pipes,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                match self.node_report() {
                    Some(report) => anyhow::bail!("Git service did not start: {}. {}", error, report),
                    None => anyhow::bail!("Git service did not start: {}", error),
                }
            }
        };

        // The reader thread continues with the handshake's buffered reader, so nothing read ahead is lost.
        let waiters = Arc::new(Mutex::new(Waiters::default()));
        let connection = Connection { child, stdin, waiters: Arc::clone(&waiters) };
        std::thread::Builder::new()
            .name("git-service-reader".to_string())
            .spawn(move || read_responses(reader, waiters))
            .context("Failed to start the Git service reader")?;
        Ok(connection)
    }

    /// What a failed start tells the user about Node.js. Windows keeps its original messages.
    fn node_report(&self) -> Option<String> {
        #[cfg(unix)]
        return Some(describe_node(&self.program, crate::login_path::login_path()));
        #[cfg(not(unix))]
        None
    }

    pub fn execute(&self, command_type: &str, payload: serde_json::Value) -> Result<serde_json::Value> {
        let command = IPCCommand {
            id: format!("cmd_{}", self.command_counter.fetch_add(1, Ordering::Relaxed) + 1),
            command_type: command_type.to_string(),
            payload,
        };
        let json = serde_json::to_string(&command)?;
        let (sender, response) = mpsc::channel();

        // The connection lock covers only the send, never the wait for the response.
        let waiters = {
            let mut guard = lock(&self.connection);
            if guard.as_mut().is_some_and(|connection| connection.is_dead()) {
                eprintln!("[Rust] Git service is not running; restarting it");
                *guard = None;
            }
            if guard.is_none() {
                *guard = Some(self.connect()?);
            }
            let connection = guard.as_mut().context("Git service not running")?;

            // Register under the same lock the reader closes under: a waiter added after the close
            // would never be woken.
            let sent = {
                let mut waiters = lock(&connection.waiters);
                if waiters.closed {
                    Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "the service has stopped"))
                } else {
                    waiters.by_id.insert(command.id.clone(), sender);
                    Ok(())
                }
            }
            .and_then(|_| writeln!(connection.stdin, "{}", json))
            .and_then(|_| connection.stdin.flush());
            let waiters = Arc::clone(&connection.waiters);
            if let Err(error) = sent {
                *guard = None;
                return Err(anyhow::anyhow!("Could not reach the Git service for {}: {}. It restarts on the next action.", command_type, error));
            }
            waiters
        };

        let response = match response.recv_timeout(self.response_timeout) {
            Ok(response) => response,
            Err(RecvTimeoutError::Disconnected) => {
                anyhow::bail!("Git service stopped while running {}. It restarts on the next action.", command_type)
            }
            Err(RecvTimeoutError::Timeout) => {
                lock(&waiters).by_id.remove(&command.id);
                anyhow::bail!("Git service did not respond to {} within {} minutes", command_type, self.response_timeout.as_secs() / 60)
            }
        };

        if response.success {
            Ok(response.data.unwrap_or(serde_json::json!(null)))
        } else {
            Err(anyhow::anyhow!(
                "Git service error: {}",
                response.error.unwrap_or_else(|| "Unknown error".to_string())
            ))
        }
    }

    pub fn check_status(&self, repo_path: &str) -> Result<StatusInfo> {
        let payload = serde_json::json!({ "repoPath": repo_path });
        let result = self.execute("checkStatus", payload)?;
        let status: StatusInfo = serde_json::from_value(result)?;
        Ok(status)
    }

    pub fn validate_before_sync(&self, repo_path: &str, selected_files: Option<Vec<String>>) -> Result<crate::models::PreSyncValidation> {
        let payload = publish_payload(repo_path, None, None, None, &PublishOptions { selected_files, allow_warnings: false });
        let result = self.execute("validateBeforeSync", payload)?;
        let validation: crate::models::PreSyncValidation = serde_json::from_value(result)?;
        Ok(validation)
    }

    pub fn push_local(
        &self,
        repo_path: &str,
        remote_url: Option<&str>,
        commit_message: Option<&str>,
        commit_description: Option<&str>,
        options: &PublishOptions,
    ) -> Result<PushResult> {
        let payload = publish_payload(repo_path, remote_url, commit_message, commit_description, options);
        let result = self.execute("pushLocal", payload)?;
        let push_result: PushResult = serde_json::from_value(result)?;
        Ok(push_result)
    }

    pub fn merge_branches(&self, repo_path: &str, branches: &[String], remote_url: Option<&str>) -> Result<MergeResult> {
        let mut payload = serde_json::json!({
            "repoPath": repo_path,
            "branches": branches
        });
        if let Some(url) = remote_url {
            payload["remoteUrl"] = serde_json::json!(url);
        }
        let result = self.execute("mergeBranches", payload)?;
        let merged: MergeResult = serde_json::from_value(result)?;
        Ok(merged)
    }

    pub fn pull_branches(&self, repo_path: &str, branches: &[String], remote_url: Option<&str>) -> Result<Vec<String>> {
        let mut payload = serde_json::json!({
            "repoPath": repo_path,
            "branches": branches
        });
        if let Some(url) = remote_url {
            payload["remoteUrl"] = serde_json::json!(url);
        }
        let result = self.execute("pullBranches", payload)?;
        let pulled: PullResult = serde_json::from_value(result)?;
        Ok(pulled.pulled)
    }

    pub fn full_sync(
        &self,
        repo_path: &str,
        remote_url: Option<&str>,
        commit_message: Option<&str>,
        commit_description: Option<&str>,
        options: &PublishOptions,
    ) -> Result<FullSyncResult> {
        let payload = publish_payload(repo_path, remote_url, commit_message, commit_description, options);
        let result = self.execute("fullSync", payload)?;
        let sync_result: FullSyncResult = serde_json::from_value(result)?;
        Ok(sync_result)
    }

    /// Forwards an already-validated recovery request. The service owns the vault
    /// location, so only the source path and the request travel over IPC. The token travels
    /// with the request, so a recovery for another project cannot change it; callers must not log it.
    pub fn recovery(&self, repo_path: &str, request: serde_json::Value, token: Option<&str>) -> Result<serde_json::Value> {
        let vault_root = crate::app_data::config_dir()?.join("checkpoints");
        let mut payload = serde_json::json!({ "repoPath": repo_path, "request": request, "vaultRoot": vault_root });
        if let Some(token) = token {
            payload["token"] = serde_json::json!(token);
        }
        self.execute("recovery", payload)
    }

    pub fn verify_github_token(&self, token: &str) -> Result<TokenVerification> {
        let payload = serde_json::json!({ "token": token });
        let result = self.execute("verifyGithubToken", payload)?;
        let verification: TokenVerification = serde_json::from_value(result)?;
        Ok(verification)
    }

    pub fn list_github_repos(&self, token: &str) -> Result<Vec<GitHubRepository>> {
        let payload = serde_json::json!({ "token": token });
        let result = self.execute("listGithubRepos", payload)?;
        let repos: Vec<GitHubRepository> = serde_json::from_value(result)?;
        Ok(repos)
    }

    pub fn clone_repository(&self, github_url: &str, local_path: &str) -> Result<()> {
        let payload = serde_json::json!({
            "githubUrl": github_url,
            "localPath": local_path
        });
        self.execute("cloneRepository", payload)?;
        Ok(())
    }

    pub fn create_github_repository(&self, token: &str, repo_name: &str, is_private: bool) -> Result<String> {
        let payload = serde_json::json!({
            "token": token,
            "repoName": repo_name,
            "isPrivate": is_private
        });
        let result = self.execute("createGithubRepository", payload)?;
        let clone_url: String = serde_json::from_value(result["cloneUrl"].clone())?;
        Ok(clone_url)
    }

    pub fn init_repository(&self, local_path: &str) -> Result<()> {
        let payload = serde_json::json!({ "localPath": local_path });
        self.execute("initRepository", payload)?;
        Ok(())
    }

    pub fn add_remote(&self, local_path: &str, remote_name: &str, remote_url: &str) -> Result<()> {
        let payload = serde_json::json!({
            "localPath": local_path,
            "remoteName": remote_name,
            "remoteUrl": remote_url
        });
        self.execute("addRemote", payload)?;
        Ok(())
    }

    // Advanced Git Features
    pub fn get_branches(&self, repo_path: &str) -> Result<Vec<BranchInfo>> {
        let payload = serde_json::json!({ "repoPath": repo_path });
        let result = self.execute("getBranches", payload)?;
        let branches: Vec<BranchInfo> = serde_json::from_value(result)?;
        Ok(branches)
    }

    pub fn create_branch(&self, repo_path: &str, branch_name: &str, checkout: bool) -> Result<()> {
        let payload = serde_json::json!({
            "repoPath": repo_path,
            "branchName": branch_name,
            "checkout": checkout
        });
        self.execute("createBranch", payload)?;
        Ok(())
    }

    pub fn switch_branch(&self, repo_path: &str, branch_name: &str) -> Result<()> {
        let payload = serde_json::json!({
            "repoPath": repo_path,
            "branchName": branch_name
        });
        self.execute("switchBranch", payload)?;
        Ok(())
    }

    pub fn delete_branch(&self, repo_path: &str, branch_name: &str, force: bool) -> Result<()> {
        let payload = serde_json::json!({
            "repoPath": repo_path,
            "branchName": branch_name,
            "force": force
        });
        self.execute("deleteBranch", payload)?;
        Ok(())
    }

    pub fn get_commit_history(&self, repo_path: &str, limit: u32) -> Result<Vec<CommitInfo>> {
        let payload = serde_json::json!({
            "repoPath": repo_path,
            "limit": limit
        });
        let result = self.execute("getCommitHistory", payload)?;
        let commits: Vec<CommitInfo> = serde_json::from_value(result)?;
        Ok(commits)
    }

    pub fn get_file_changes(&self, repo_path: &str) -> Result<Vec<FileChangeInfo>> {
        let result = self.execute("getFileChanges", serde_json::json!({ "repoPath": repo_path }))?;
        Ok(serde_json::from_value(result)?)
    }

    pub fn get_diff(&self, repo_path: &str, file_path: Option<String>, scope: Option<String>) -> Result<Vec<DiffInfo>> {
        let payload = serde_json::json!({
            "repoPath": repo_path,
            "filePath": file_path,
            "scope": scope.unwrap_or_else(|| "all".to_string())
        });
        let result = self.execute("getDiff", payload)?;
        let diffs: Vec<DiffInfo> = serde_json::from_value(result)?;
        Ok(diffs)
    }

    pub fn create_stash(&self, repo_path: &str, message: Option<String>) -> Result<()> {
        let payload = serde_json::json!({
            "repoPath": repo_path,
            "message": message
        });
        self.execute("createStash", payload)?;
        Ok(())
    }

    pub fn list_stashes(&self, repo_path: &str) -> Result<Vec<StashInfo>> {
        let payload = serde_json::json!({ "repoPath": repo_path });
        let result = self.execute("listStashes", payload)?;
        let stashes: Vec<StashInfo> = serde_json::from_value(result)?;
        Ok(stashes)
    }

    pub fn apply_stash(&self, repo_path: &str, index: u32) -> Result<()> {
        let payload = serde_json::json!({
            "repoPath": repo_path,
            "index": index
        });
        self.execute("applyStash", payload)?;
        Ok(())
    }

    pub fn pop_stash(&self, repo_path: &str) -> Result<()> {
        let payload = serde_json::json!({ "repoPath": repo_path });
        self.execute("popStash", payload)?;
        Ok(())
    }

    pub fn drop_stash(&self, repo_path: &str, index: u32) -> Result<()> {
        let payload = serde_json::json!({
            "repoPath": repo_path,
            "index": index
        });
        self.execute("dropStash", payload)?;
        Ok(())
    }

    pub fn create_tag(&self, repo_path: &str, tag_name: &str, message: Option<String>) -> Result<()> {
        let payload = serde_json::json!({
            "repoPath": repo_path,
            "tagName": tag_name,
            "message": message
        });
        self.execute("createTag", payload)?;
        Ok(())
    }

    pub fn list_tags(&self, repo_path: &str) -> Result<Vec<TagInfo>> {
        let payload = serde_json::json!({ "repoPath": repo_path });
        let result = self.execute("listTags", payload)?;
        let tags: Vec<TagInfo> = serde_json::from_value(result)?;
        Ok(tags)
    }

    pub fn push_tag(&self, repo_path: &str, tag_name: &str) -> Result<()> {
        let payload = serde_json::json!({
            "repoPath": repo_path,
            "tagName": tag_name
        });
        self.execute("pushTag", payload)?;
        Ok(())
    }

    pub fn push_all_tags(&self, repo_path: &str) -> Result<()> {
        let payload = serde_json::json!({ "repoPath": repo_path });
        self.execute("pushAllTags", payload)?;
        Ok(())
    }

    pub fn delete_tag(&self, repo_path: &str, tag_name: &str) -> Result<()> {
        let payload = serde_json::json!({
            "repoPath": repo_path,
            "tagName": tag_name
        });
        self.execute("deleteTag", payload)?;
        Ok(())
    }

    pub fn cherry_pick(&self, repo_path: &str, commit_hash: &str) -> Result<()> {
        let payload = serde_json::json!({
            "repoPath": repo_path,
            "commitHash": commit_hash
        });
        self.execute("cherryPick", payload)?;
        Ok(())
    }

    pub fn get_current_branch(&self, repo_path: &str) -> Result<String> {
        let payload = serde_json::json!({ "repoPath": repo_path });
        let result = self.execute("getCurrentBranch", payload)?;
        let branch: String = serde_json::from_value(result)?;
        Ok(branch)
    }

    // ==================== ANALYTICS ====================

    /// One round-trip for every repository; the service reads them in parallel.
    pub fn get_analytics_snapshots(
        &self,
        repo_paths: &[&str],
        history_since: &str,
        recent_since: &str,
        recent_limit: u32,
    ) -> Result<Vec<AnalyticsSnapshotResult>> {
        let payload = serde_json::json!({
            "repoPaths": repo_paths,
            "params": {
                "historySince": history_since,
                "recentSince": recent_since,
                "recentLimit": recent_limit
            }
        });
        let result = self.execute("getAnalyticsSnapshots", payload)?;
        let snapshots: Vec<AnalyticsSnapshotResult> = serde_json::from_value(result)?;
        Ok(snapshots)
    }
}

/// What a publish may commit. `selected_files: None` pushes existing commits only.
#[derive(Debug, Clone, Default)]
pub struct PublishOptions {
    pub selected_files: Option<Vec<String>>,
    pub allow_warnings: bool,
}

fn publish_payload(
    repo_path: &str,
    remote_url: Option<&str>,
    commit_message: Option<&str>,
    commit_description: Option<&str>,
    options: &PublishOptions,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "repoPath": repo_path,
        "allowWarnings": options.allow_warnings,
    });
    if let Some(url) = remote_url {
        payload["remoteUrl"] = serde_json::json!(url);
    }
    if let Some(msg) = commit_message {
        payload["commitMessage"] = serde_json::json!(msg);
    }
    if let Some(desc) = commit_description {
        payload["commitDescription"] = serde_json::json!(desc);
    }
    if let Some(files) = &options.selected_files {
        payload["selectedFiles"] = serde_json::json!(files);
    }
    payload
}

// Response types matching Git service output. Fields the service added later are
// optional so an older service build still decodes.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusInfo {
    #[serde(default)]
    pub is_git_repo: Option<bool>,
    #[serde(default)]
    pub has_remote: Option<bool>,
    #[serde(default)]
    pub current_branch: Option<String>,
    #[serde(default)]
    pub upstream: Option<String>,
    #[serde(default)]
    pub remote_url: Option<String>,
    #[serde(default)]
    pub behind_commits: u32,
    #[serde(default)]
    pub remote_checked_at: Option<String>,
    #[serde(default)]
    pub remote_error: Option<String>,
    pub uncommitted_files: u32,
    pub untracked_files: u32,
    pub modified_files: Vec<String>,
    pub unpushed_commits: u32,
    pub remote_branches: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PushResult {
    pub committed: u32,
    pub pushed: bool,
}

impl PushResult {
    /// The service reports whether a push happened, not how many; a push is one update.
    pub fn pushed_count(&self) -> u32 {
        if self.pushed { 1 } else { 0 }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MergeResult {
    pub merged: Vec<String>,
    #[serde(default)]
    pub deleted: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PullResult {
    pub pulled: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FullSyncResult {
    pub success: bool,
    pub message: String,
    #[serde(default)]
    pub committed: Option<u32>,
    #[serde(default)]
    pub pushed: Option<u32>,
    #[serde(default)]
    pub pulled: Option<u32>,
    #[serde(default)]
    pub merged: Option<Vec<String>>,
    #[serde(default)]
    pub deleted: Option<Vec<String>>,
    #[serde(default)]
    pub errors: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TokenVerification {
    pub username: String,
    pub valid: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepository {
    pub name: String,
    pub full_name: String,
    pub clone_url: String,
    pub html_url: String,
    pub owner: String,
    pub is_private: bool,
    pub default_branch: String,
}

// Advanced Git Features Types
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    pub commit: String,
    pub label: String,
    pub is_remote: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommitInfo {
    pub hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub message: String,
    pub body: String,
    pub refs: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffChange {
    pub line: i32,
    #[serde(rename = "type")]
    pub change_type: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffInfo {
    pub file_name: String,
    pub changes: Vec<DiffChange>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub binary: bool,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileChangeInfo {
    pub path: String,
    pub staged: Option<String>,
    pub unstaged: Option<String>,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StashInfo {
    pub index: u32,
    pub hash: String,
    pub message: String,
    pub date: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TagInfo {
    pub name: String,
}

// Analytics Types
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsSnapshot {
    pub commit_dates: Vec<String>,
    pub recent_commits: Vec<AnalyticsCommit>,
    pub branches: Vec<BranchStaleness>,
    pub days_since_last_commit: Option<i32>,
    pub tag_count: u32,
    pub stash_count: u32,
}

/// Exactly one of `snapshot` and `error` is set.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsSnapshotResult {
    pub repo_path: String,
    pub snapshot: Option<AnalyticsSnapshot>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsCommit {
    pub hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub message: String,
    pub branch: String,
    pub files_changed: u32,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStaleness {
    pub name: String,
    pub days_since_last_commit: i32,
    pub is_remote: bool,
    pub last_commit_hash: String,
    pub last_commit_date: String,
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publish_payload_omits_selection_when_none() {
        let payload = publish_payload("C:/src/app", None, None, None, &PublishOptions::default());
        assert_eq!(payload["repoPath"], "C:/src/app");
        assert_eq!(payload["allowWarnings"], false);
        assert!(payload.get("selectedFiles").is_none(), "no selection must not become an empty/all selection");
        assert!(payload.get("remoteUrl").is_none());
    }

    #[test]
    fn publish_payload_carries_options_and_commit_text() {
        let options = PublishOptions {
            selected_files: Some(vec!["src/a.rs".to_string(), "b.txt".to_string()]),
            allow_warnings: true,
        };
        let payload = publish_payload(
            "C:/src/app",
            Some("https://github.com/o/app.git"),
            Some("msg"),
            Some("desc"),
            &options,
        );
        assert_eq!(payload["selectedFiles"], serde_json::json!(["src/a.rs", "b.txt"]));
        assert_eq!(payload["allowWarnings"], true);
        assert_eq!(payload["remoteUrl"], "https://github.com/o/app.git");
        assert_eq!(payload["commitMessage"], "msg");
        assert_eq!(payload["commitDescription"], "desc");
    }

    #[test]
    fn publish_payload_keeps_an_explicit_empty_selection() {
        let options = PublishOptions { selected_files: Some(Vec::new()), allow_warnings: false };
        let payload = publish_payload("p", None, None, None, &options);
        assert_eq!(payload["selectedFiles"], serde_json::json!([]));
    }

    #[test]
    fn status_info_decodes_new_service_output() {
        let info: StatusInfo = serde_json::from_value(serde_json::json!({
            "isGitRepo": true, "hasRemote": true, "currentBranch": "main",
            "upstream": "origin/main", "behindCommits": 2,
            "remoteCheckedAt": "2026-09-21T00:00:00Z", "remoteError": null,
            "uncommittedFiles": 1, "untrackedFiles": 0, "modifiedFiles": ["a"],
            "unpushedCommits": 3, "remoteBranches": ["feature"]
        }))
        .unwrap();
        assert_eq!(info.is_git_repo, Some(true));
        assert_eq!(info.current_branch.as_deref(), Some("main"));
        assert_eq!(info.upstream.as_deref(), Some("origin/main"));
        assert_eq!(info.behind_commits, 2);
        assert_eq!(info.remote_error, None);
    }

    #[test]
    fn status_info_decodes_older_service_output() {
        let info: StatusInfo = serde_json::from_value(serde_json::json!({
            "uncommittedFiles": 0, "untrackedFiles": 0, "modifiedFiles": [],
            "unpushedCommits": 0, "remoteBranches": []
        }))
        .unwrap();
        assert_eq!(info.is_git_repo, None);
        assert_eq!(info.has_remote, None);
        assert_eq!(info.remote_checked_at, None);
        assert_eq!(info.behind_commits, 0);
    }

    #[test]
    fn push_count_follows_the_reported_bool() {
        assert_eq!(PushResult { committed: 2, pushed: true }.pushed_count(), 1);
        assert_eq!(PushResult { committed: 2, pushed: false }.pushed_count(), 0);
    }

    #[test]
    fn full_sync_result_does_not_invent_pushed_or_deleted() {
        let result: FullSyncResult = serde_json::from_value(serde_json::json!({
            "success": true, "message": "ok", "committed": 1, "merged": []
        }))
        .unwrap();
        assert_eq!(result.pushed, None);
        assert_eq!(result.deleted, None);

        let result: FullSyncResult = serde_json::from_value(serde_json::json!({
            "success": true, "message": "ok", "committed": 1, "pushed": 0
        }))
        .unwrap();
        assert_eq!(result.pushed, Some(0));
    }

    // A stand-in service that speaks the real line protocol. Single quotes only, so the script
    // survives argument quoting on every platform.
    const FAKE_SERVICE: &str = "\
        const rl = require('readline').createInterface({ input: process.stdin });\
        const reply = (id, data) => console.log(JSON.stringify({ id, success: true, data }));\
        rl.on('line', (line) => {\
          const { id, type, payload } = JSON.parse(line);\
          if (type === 'ping') reply(id, 'pong');\
          else if (type === 'echo') reply(id, payload);\
          else if (type === 'delayed') setTimeout(() => reply(id, payload), payload.ms);\
          else if (type === 'noisy') { console.log('not a response'); console.log('{}'); reply(id, payload); }\
          else if (type === 'crash') process.exit(1);\
        });";

    fn fake_service(response_timeout: Duration) -> GitService {
        GitService::with_launch("node".into(), vec!["-e".into(), FAKE_SERVICE.into()], response_timeout)
    }

    #[test]
    fn a_slow_request_does_not_delay_another_caller() {
        let service = fake_service(Duration::from_secs(20));
        service.execute("echo", serde_json::json!(null)).unwrap(); // connect before timing anything
        std::thread::scope(|scope| {
            let slow = scope.spawn(|| service.execute("delayed", serde_json::json!({ "ms": 2000, "tag": "slow" })));
            std::thread::sleep(Duration::from_millis(300));

            let fast = service.execute("echo", serde_json::json!({ "tag": "fast" })).unwrap();

            assert!(!slow.is_finished(), "the fast request must not wait for the slow one");
            assert_eq!(fast["tag"], "fast");
            assert_eq!(slow.join().unwrap().unwrap()["tag"], "slow");
        });
    }

    #[test]
    fn a_crash_fails_waiting_callers_and_the_next_request_restarts_the_service() {
        let service = fake_service(Duration::from_secs(20));
        std::thread::scope(|scope| {
            let waiting = scope.spawn(|| service.execute("unanswered", serde_json::json!({})));
            std::thread::sleep(Duration::from_millis(300));

            let crashed = service.execute("crash", serde_json::json!({})).unwrap_err().to_string();
            let abandoned = waiting.join().unwrap().unwrap_err().to_string();

            assert!(crashed.contains("stopped while running crash"), "{}", crashed);
            assert!(abandoned.contains("stopped while running unanswered"), "{}", abandoned);
        });
        assert_eq!(service.execute("echo", serde_json::json!("again")).unwrap(), "again");
    }

    #[test]
    fn output_that_is_not_a_response_does_not_shift_later_answers() {
        let service = fake_service(Duration::from_secs(20));
        assert_eq!(service.execute("noisy", serde_json::json!(1)).unwrap(), 1);
        assert_eq!(service.execute("echo", serde_json::json!(2)).unwrap(), 2);
    }

    #[test]
    fn an_unanswered_request_times_out_and_leaves_the_service_usable() {
        let service = fake_service(Duration::from_millis(400));
        let error = service.execute("unanswered", serde_json::json!({})).unwrap_err().to_string();
        assert!(error.contains("did not respond to unanswered"), "{}", error);
        assert_eq!(service.execute("echo", serde_json::json!("still here")).unwrap(), "still here");
    }

    #[test]
    fn a_node_below_the_floor_is_named_with_its_version_and_path() {
        let old = describe_node_probe("v12.22.9 /usr/bin/node\n");
        assert!(old.contains("v12.22.9 at /usr/bin/node is too old"), "{}", old);
        assert!(old.contains("Node.js 20 or later"), "{}", old);

        let current = describe_node_probe("v20.19.2 /Users/me/.nvm/versions/node/v20.19.2/bin/node\n");
        assert_eq!(current, "It ran Node.js v20.19.2 at /Users/me/.nvm/versions/node/v20.19.2/bin/node.");

        let silent = describe_node_probe("");
        assert!(silent.contains("did not report its version") && silent.contains("20 or later"), "{}", silent);
    }

    #[test]
    fn a_service_that_cannot_start_is_reported() {
        let service = GitService::with_launch("node".into(), vec!["-e".into(), "process.exit(3)".into()], Duration::from_secs(20));
        let error = service.execute("echo", serde_json::json!({})).unwrap_err().to_string();
        assert!(error.contains("Git service did not start"), "{}", error);
    }
}
