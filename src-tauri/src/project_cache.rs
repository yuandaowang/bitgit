use crate::models::Project;
use anyhow::{Context, Result};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

// Serializes every cache read and write in this process. Loading can rewrite the main
// file from the backup and every save reuses one `.tmp` path, so readers take the lock
// too; without it a load racing a save restores stale data over the fresh file.
// Two BitGit processes on the same data directory are not coordinated.
static CACHE_LOCK: Mutex<()> = Mutex::new(());

fn lock_cache() -> MutexGuard<'static, ()> {
    // Files are replaced atomically, so a panic while holding the lock leaves no
    // half-written state behind and the guard can be reused safely.
    CACHE_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

// A read failing for any reason but "not found" (sharing violation, antivirus lock,
// permissions) is retried, sleeping `delay * attempt` in between, before the file is
// reported unreadable. Worst case is about 150 ms per file.
const READ_ATTEMPTS: u32 = 4;
const READ_RETRY_DELAY: Duration = Duration::from_millis(25);

const QUARANTINE_NAME_ATTEMPTS: u32 = 100;

/// What a cache file held when it was read.
enum CacheRead {
    Missing,
    Valid(Vec<Project>),
    /// Readable but not a valid project list: corrupt, truncated, or holding a value this
    /// build does not know (for example a newer status). `bytes` are the exact content.
    Invalid { bytes: Vec<u8>, reason: String },
    /// Could not be read even after retrying, so nothing is known about its content.
    Unreadable(io::Error),
}

/// Locations of the cache files. `in_dir` lets tests use a disposable directory.
pub struct ProjectStore {
    dir: PathBuf,
    // Where invalid files are preserved; always `dir` outside tests.
    quarantine_dir: PathBuf,
}

impl ProjectStore {
    pub fn in_dir(dir: impl Into<PathBuf>) -> Self {
        let dir = dir.into();
        Self { quarantine_dir: dir.clone(), dir }
    }

    #[cfg(test)]
    fn with_quarantine_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.quarantine_dir = dir.into();
        self
    }

    fn default_location() -> Result<Self> {
        let dir = crate::app_data::config_dir()?;
        Ok(Self::in_dir(dir))
    }

    fn cache_path(&self) -> PathBuf {
        self.dir.join("projects.json")
    }

    fn backup_path(&self) -> PathBuf {
        self.cache_path().with_extension("json.bak")
    }

    fn temp_path(&self) -> PathBuf {
        self.cache_path().with_extension("json.tmp")
    }

    /// Load projects with automatic recovery from the backup.
    pub fn load(&self) -> Vec<Project> {
        let _guard = lock_cache();
        self.load_locked()
    }

    /// Run a read-modify-write as one step. The file is rewritten only if `f` changed
    /// the list. `f` must not call back into the cache (the lock is not reentrant).
    pub fn modify<R>(&self, f: impl FnOnce(&mut Vec<Project>) -> R) -> Result<R> {
        let _guard = lock_cache();
        let mut projects = self.load_locked();
        let before = projects.clone();
        let result = f(&mut projects);
        if projects != before {
            self.write_locked(&projects)?;
        }
        Ok(result)
    }

    /// Add or replace a project by id.
    pub fn upsert(&self, project: Project) -> Result<()> {
        self.modify(|projects| {
            if let Some(existing) = projects.iter_mut().find(|p| p.id == project.id) {
                *existing = project;
            } else {
                projects.push(project);
            }
        })
    }

    /// Mutate one stored project in place, so fields other callers changed while a
    /// slow operation ran are kept. Returns the updated project.
    pub fn update(&self, project_id: &str, f: impl FnOnce(&mut Project)) -> Result<Project> {
        self.modify(|projects| {
            projects.iter_mut().find(|p| p.id == project_id).map(|project| {
                f(project);
                project.clone()
            })
        })?
        .ok_or_else(|| anyhow::anyhow!("Project not found: {}", project_id))
    }

    pub fn delete(&self, project_id: &str) -> Result<()> {
        self.modify(|projects| projects.retain(|p| p.id != project_id))
    }

    /// Reading never writes, except restoring a missing or invalid main file from a valid
    /// backup, which preserves the invalid original first. An unreadable main file is
    /// never touched; the backup is only returned.
    fn load_locked(&self) -> Vec<Project> {
        let cache_path = self.cache_path();
        let backup_path = self.backup_path();

        // Try main file first
        let main = match read_cache_file(&cache_path) {
            CacheRead::Valid(projects) => {
                eprintln!(
                    "[ProjectCache] Loaded {} projects from {:?}",
                    projects.len(),
                    cache_path
                );
                return projects;
            }
            other => other,
        };
        log_unusable(&cache_path, &main);

        // Main file missing, invalid or unreadable - try backup
        let backup = match read_cache_file(&backup_path) {
            CacheRead::Valid(projects) => {
                eprintln!(
                    "[ProjectCache] Recovered {} projects from backup",
                    projects.len()
                );

                // Silently restore backup as main file
                if let Err(e) = self.restore_from_backup(&main, &projects) {
                    eprintln!("[ProjectCache] Warning: Could not restore backup: {:#}", e);
                    // Return the recovered projects anyway
                }

                return projects;
            }
            other => other,
        };
        log_unusable(&backup_path, &backup);

        // Nothing usable. Whatever is on disk stays there until a write preserves it.
        if matches!(main, CacheRead::Missing) && matches!(backup, CacheRead::Missing) {
            eprintln!("[ProjectCache] No cache files found, starting fresh");
        } else {
            eprintln!(
                "[ProjectCache] Cache files exist but cannot be used, starting with an empty list; \
                 the originals are kept and are copied aside before any write replaces them"
            );
        }

        Vec::new()
    }

    /// Save projects to the cache file using atomic write with backup
    ///
    /// This function ensures data integrity through:
    /// 1. Serialize and validate data before writing
    /// 2. Write to a temp file first
    /// 3. Verify the temp file is readable and valid
    /// 4. Preserve invalid existing files; refuse to replace unreadable ones
    /// 5. Backup current file (if valid) before replacing
    /// 6. Atomic rename of temp to main file
    fn write_locked(&self, projects: &[Project]) -> Result<()> {
        let cache_path = self.cache_path();
        let backup_path = self.backup_path();
        let temp_path = self.temp_path();

        fs::create_dir_all(&self.dir).context("Failed to create config directory")?;

        // Step 1: Serialize to JSON
        let json = serde_json::to_string_pretty(projects)
            .context("Failed to serialize projects")?;

        // Step 2: Validate what we're about to write (sanity check)
        if projects.len() > 0 && validate_json_content(&json).is_none() {
            return Err(anyhow::anyhow!(
                "Internal error: serialized JSON failed validation"
            ));
        }

        // Step 3: Write to temp file
        fs::write(&temp_path, &json)
            .context("Failed to write temp file")?;

        // Step 4: Verify temp file by reading it back
        let verification = try_read_valid_file(&temp_path);
        if projects.len() > 0 && verification.is_none() {
            // Clean up failed temp file
            let _ = fs::remove_file(&temp_path);
            return Err(anyhow::anyhow!(
                "Write verification failed: temp file is not valid"
            ));
        }

        // Step 5: Nothing existing is destroyed unless its content is valid or has been
        // copied aside. The main file is always replaced; the backup only when it is
        // overwritten from a valid main file.
        let main = read_cache_file(&cache_path);
        let main_is_valid = matches!(main, CacheRead::Valid(_));
        let preserved = self.preserve_before_replace(&cache_path, &main).and_then(|()| {
            if main_is_valid {
                self.preserve_before_replace(&backup_path, &read_cache_file(&backup_path))
            } else {
                Ok(())
            }
        });
        if let Err(e) = preserved {
            // The temp file is ours and nothing has been replaced.
            let _ = fs::remove_file(&temp_path);
            return Err(e);
        }

        // Backup current file if it is valid
        if main_is_valid {
            // Use copy instead of rename so we don't lose data if rename fails
            if let Err(e) = fs::copy(&cache_path, &backup_path) {
                eprintln!("[ProjectCache] Warning: Could not create backup: {}", e);
                // Continue anyway - we still have the valid temp file
            }
        }
        // If the current file is invalid, the backup is left as is (it may be the only good copy)

        // std::fs::rename replaces a file on Windows too. Removing main first would
        // introduce a crash window between deletion and publication.
        fs::rename(&temp_path, &cache_path)
            .context("Failed to rename temp file to cache file")?;

        eprintln!(
            "[ProjectCache] Saved {} projects to {:?}",
            projects.len(),
            cache_path
        );
        Ok(())
    }

    /// Restore backup file as the main cache file
    fn restore_from_backup(&self, main: &CacheRead, projects: &[Project]) -> Result<()> {
        let cache_path = self.cache_path();

        // Re-save the recovered projects properly (this creates a fresh valid main file)
        let json = serde_json::to_string_pretty(projects)
            .context("Failed to serialize recovered projects")?;

        let temp_path = self.temp_path();

        // Write to temp first
        fs::write(&temp_path, &json)
            .context("Failed to write temp file during recovery")?;

        // Verify
        if try_read_valid_file(&temp_path).is_none() {
            let _ = fs::remove_file(&temp_path);
            return Err(anyhow::anyhow!("Recovery verification failed"));
        }

        // The invalid main file is copied aside before it is replaced; an unreadable one
        // is left alone.
        if let Err(e) = self.preserve_before_replace(&cache_path, main) {
            let _ = fs::remove_file(&temp_path);
            return Err(e);
        }

        // Replace the preserved main directly; a failed rename leaves it in place.
        fs::rename(&temp_path, &cache_path)
            .context("Failed to restore cache file")?;

        eprintln!("[ProjectCache] Successfully restored {} projects from backup", projects.len());
        Ok(())
    }

    /// Called before a cache file is replaced. Invalid content is copied aside first and an
    /// error is returned if that fails; a file that cannot be read is never replaced.
    fn preserve_before_replace(&self, path: &Path, state: &CacheRead) -> Result<()> {
        let name = file_name(path);
        match state {
            CacheRead::Missing | CacheRead::Valid(_) => Ok(()),
            // Nothing to keep in a zero-length file.
            CacheRead::Invalid { bytes, .. } if bytes.is_empty() => Ok(()),
            CacheRead::Invalid { bytes, reason } => {
                let kept = self.quarantine(path, bytes).map_err(|e| {
                    anyhow::anyhow!(
                        "Refusing to replace {}: it is not a valid project list and could not be preserved ({:#})",
                        name,
                        e
                    )
                })?;
                eprintln!(
                    "[ProjectCache] {} is not a valid project list ({}); original preserved at {:?}",
                    name, reason, kept
                );
                Ok(())
            }
            CacheRead::Unreadable(e) => Err(anyhow::anyhow!(
                "Refusing to replace {} because it cannot be read: {}",
                name,
                e
            )),
        }
    }

    /// Copy `bytes` (the exact content read from `source`) to a new file in the quarantine
    /// directory, named `<file>.corrupt-<UTC timestamp>-<pid>-<counter>`. The copy is
    /// created exclusively, so no earlier quarantine is ever overwritten, and read back
    /// before it counts. Quarantined files are never deleted automatically.
    fn quarantine(&self, source: &Path, bytes: &[u8]) -> Result<PathBuf> {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);

        let name = file_name(source);
        let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ");

        for _ in 0..QUARANTINE_NAME_ATTEMPTS {
            let candidate = self.quarantine_dir.join(format!(
                "{}.corrupt-{}-{}-{}",
                name,
                stamp,
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            match write_new_file(&candidate, bytes) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => {
                    return Err(anyhow::Error::new(e)
                        .context(format!("Failed to write {:?}", candidate)))
                }
            }

            // The file is ours (created exclusively), so a bad copy can be removed.
            return match fs::read(&candidate) {
                Ok(copy) if copy == bytes => Ok(candidate),
                Ok(_) => {
                    let _ = fs::remove_file(&candidate);
                    Err(anyhow::anyhow!("copy at {:?} differs from the original", candidate))
                }
                Err(e) => {
                    let _ = fs::remove_file(&candidate);
                    Err(anyhow::Error::new(e)
                        .context(format!("Failed to verify {:?}", candidate)))
                }
            };
        }
        Err(anyhow::anyhow!("could not find an unused quarantine name for {}", name))
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Create `path` holding `bytes`, failing with `AlreadyExists` rather than replacing
/// anything. A partial file left by a failed write is removed.
fn write_new_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = written {
        // create_new succeeded, so the partial file is ours; the write error is reported.
        let _ = fs::remove_file(path);
        return Err(e);
    }
    Ok(())
}

fn log_unusable(path: &Path, state: &CacheRead) {
    match state {
        CacheRead::Invalid { reason, .. } => {
            eprintln!("[ProjectCache] {} is not a valid project list: {}", file_name(path), reason)
        }
        CacheRead::Unreadable(e) => {
            eprintln!("[ProjectCache] {} could not be read: {}", file_name(path), e)
        }
        CacheRead::Missing | CacheRead::Valid(_) => {}
    }
}

/// Parse a project list, saying why it was rejected.
fn parse_projects(json: &str) -> std::result::Result<Vec<Project>, String> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return Err("file is empty".to_string());
    }
    serde_json::from_str::<Vec<Project>>(trimmed).map_err(|e| e.to_string())
}

/// Validate that JSON content can be parsed as a project list
/// Returns the parsed projects if valid, None if invalid
fn validate_json_content(json: &str) -> Option<Vec<Project>> {
    parse_projects(json).ok()
}

fn classify(bytes: Vec<u8>) -> CacheRead {
    let parsed = match std::str::from_utf8(&bytes) {
        Ok(text) => parse_projects(text),
        Err(e) => Err(format!("not valid UTF-8: {}", e)),
    };
    match parsed {
        Ok(projects) => CacheRead::Valid(projects),
        Err(reason) => CacheRead::Invalid { bytes, reason },
    }
}

/// Read a cache file, telling apart "not there", "there but not a valid project list"
/// and "could not be read". Only the last is retried: a transient failure must not be
/// mistaken for corruption, and a corrupt file is not going to improve.
fn read_with_retry(
    path: &Path,
    mut read: impl FnMut(&Path) -> io::Result<Vec<u8>>,
    delay: Duration,
) -> CacheRead {
    let mut attempt = 1;
    loop {
        match read(path) {
            Ok(bytes) => return classify(bytes),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return CacheRead::Missing,
            Err(e) if attempt >= READ_ATTEMPTS => return CacheRead::Unreadable(e),
            Err(_) => {
                std::thread::sleep(delay * attempt);
                attempt += 1;
            }
        }
    }
}

fn read_cache_file(path: &Path) -> CacheRead {
    read_with_retry(path, |p| fs::read(p), READ_RETRY_DELAY)
}

/// Try to read and validate a file, returning projects if successful
fn try_read_valid_file(path: &Path) -> Option<Vec<Project>> {
    match read_cache_file(path) {
        CacheRead::Valid(projects) => Some(projects),
        _ => None,
    }
}

/// Load projects from the cache file with automatic recovery
///
/// 1. Try to load from main file
/// 2. If main is missing or invalid, try the backup
/// 3. If the backup works, restore it as the main file, copying an invalid main aside first
/// 4. Only return an empty list if both are unusable; nothing is written by the load itself
pub fn load_projects() -> Result<Vec<Project>> {
    Ok(ProjectStore::default_location()?.load())
}

/// Add or update a project in the cache
pub fn save_project(project: Project) -> Result<()> {
    ProjectStore::default_location()?.upsert(project)
}

/// Update one project in place; see [`ProjectStore::update`].
pub fn update_project(project_id: &str, f: impl FnOnce(&mut Project)) -> Result<Project> {
    ProjectStore::default_location()?.update(project_id, f)
}

/// Read-modify-write the whole list as one step; see [`ProjectStore::modify`].
pub fn modify_projects<R>(f: impl FnOnce(&mut Vec<Project>) -> R) -> Result<R> {
    ProjectStore::default_location()?.modify(f)
}

/// Delete a project from the cache
pub fn delete_project(project_id: &str) -> Result<()> {
    ProjectStore::default_location()?.delete(project_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ProjectStatistics, ProjectStatus};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    // Disposable data directory; never the real APPDATA.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "bitgit-test-{}-{}-{}-{}",
                label,
                std::process::id(),
                nanos,
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            // Best-effort cleanup of a directory this test created under the temp dir.
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample_project(id: &str) -> Project {
        Project {
            id: id.to_string(),
            name: id.to_string(),
            github_owner: None,
            github_repo: None,
            github_url: None,
            local_path: Some(format!("C:/src/{}", id)),
            project_status: ProjectStatus::LocalOnly,
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

    // Contents of the quarantine files made from `source` ("projects.json" or "projects.json.bak").
    fn quarantined(dir: &Path, source: &str) -> Vec<Vec<u8>> {
        let prefix = format!("{}.corrupt-", source);
        let mut found: Vec<Vec<u8>> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
            .map(|entry| fs::read(entry.path()).unwrap())
            .collect();
        found.sort();
        found
    }

    fn ids(store: &ProjectStore) -> Vec<String> {
        store.load().into_iter().map(|p| p.id).collect()
    }

    // A project list whose status value an older or newer build does not know.
    const UNKNOWN_STATUS: &[u8] =
        br#"[{"id":"x","name":"x","projectStatus":"from_the_future","createdAt":"2026-01-01T00:00:00Z"}]"#;

    #[test]
    fn test_validate_json_content() {
        // Empty content
        assert!(validate_json_content("").is_none());
        assert!(validate_json_content("   ").is_none());

        // Invalid JSON
        assert!(validate_json_content("not json").is_none());
        assert!(validate_json_content("{").is_none());

        // Valid empty array
        assert!(validate_json_content("[]").is_some());
        assert_eq!(validate_json_content("[]").unwrap().len(), 0);
    }

    #[test]
    fn upserted_projects_survive_a_fresh_store_and_keep_a_backup() {
        let tmp = TempDir::new("roundtrip");
        let store = ProjectStore::in_dir(&tmp.0);
        store.upsert(sample_project("a")).unwrap();
        store.upsert(sample_project("b")).unwrap();

        // A new store over the same directory models an app restart.
        let reloaded = ProjectStore::in_dir(&tmp.0).load();
        let ids: Vec<&str> = reloaded.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
        assert!(store.backup_path().exists());
    }

    #[test]
    fn corrupt_main_file_recovers_from_backup_and_is_rewritten() {
        let tmp = TempDir::new("recover");
        let store = ProjectStore::in_dir(&tmp.0);
        store.upsert(sample_project("a")).unwrap();
        store.upsert(sample_project("b")).unwrap();

        fs::write(store.cache_path(), "{ not valid json").unwrap();

        let recovered = store.load();
        assert!(!recovered.is_empty(), "backup should have been used");
        assert!(try_read_valid_file(&store.cache_path()).is_some(), "main file restored");
    }

    #[test]
    fn caches_written_by_older_versions_still_load() {
        let tmp = TempDir::new("oldcache");
        let store = ProjectStore::in_dir(&tmp.0);
        let old = r#"[{
            "id": "old-1", "name": "old",
            "githubOwner": null, "githubRepo": null, "githubUrl": null,
            "localPath": "C:/src/old", "projectStatus": "synced",
            "gitStatus": {
                "isGitRepo": true, "hasRemote": true, "uncommittedFiles": 0,
                "untrackedFiles": 0, "modifiedFiles": [], "unpushedCommits": 0,
                "remoteBranches": [], "syncStatus": "notconnected",
                "lastChecked": "2026-01-01T00:00:00Z"
            },
            "createdAt": "2026-01-01T00:00:00Z", "lastSynced": null
        }]"#;
        fs::write(store.cache_path(), old).unwrap();

        let loaded = store.load();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "old-1");
        assert!(loaded[0].labels.is_empty(), "a cache without labels loads as none");
    }

    #[test]
    fn update_changes_only_the_target_and_reports_missing_ids() {
        let tmp = TempDir::new("update");
        let store = ProjectStore::in_dir(&tmp.0);
        store.upsert(sample_project("a")).unwrap();
        store.upsert(sample_project("b")).unwrap();

        let updated = store.update("a", |p| p.favorite = Some(true)).unwrap();
        assert_eq!(updated.favorite, Some(true));

        let loaded = store.load();
        assert_eq!(loaded[0].favorite, Some(true));
        assert_eq!(loaded[1].favorite, None);

        let err = store.update("missing", |_| {}).unwrap_err();
        assert!(err.to_string().contains("Project not found: missing"));
    }

    #[test]
    fn unchanged_modify_does_not_write() {
        let tmp = TempDir::new("nowrite");
        let store = ProjectStore::in_dir(&tmp.0);
        store.modify(|_| ()).unwrap();
        assert!(!store.cache_path().exists());
    }

    #[test]
    fn concurrent_updates_do_not_lose_increments() {
        let tmp = TempDir::new("lostupdate");
        let store = Arc::new(ProjectStore::in_dir(&tmp.0));
        let mut project = sample_project("counter");
        project.statistics = Some(ProjectStatistics {
            total_syncs: 0,
            total_commits: 0,
            total_pushes: 0,
            total_merges: 0,
            total_pulls: 0,
            last_sync_date: None,
            last_commit_date: None,
        });
        store.upsert(project).unwrap();

        let threads = 8;
        let per_thread = 20;
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                let store = Arc::clone(&store);
                std::thread::spawn(move || {
                    for _ in 0..per_thread {
                        store
                            .update("counter", |p| {
                                if let Some(stats) = p.statistics.as_mut() {
                                    stats.total_syncs += 1;
                                }
                            })
                            .unwrap();
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let loaded = store.load();
        let syncs = loaded[0].statistics.as_ref().unwrap().total_syncs;
        assert_eq!(syncs, threads * per_thread);
    }

    #[test]
    fn concurrent_upserts_of_different_projects_all_persist() {
        let tmp = TempDir::new("upserts");
        let store = Arc::new(ProjectStore::in_dir(&tmp.0));

        let handles: Vec<_> = (0..8)
            .map(|t| {
                let store = Arc::clone(&store);
                std::thread::spawn(move || {
                    for i in 0..5 {
                        store.upsert(sample_project(&format!("p-{}-{}", t, i))).unwrap();
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        assert_eq!(store.load().len(), 40);
        assert!(!store.temp_path().exists(), "no stray temp file left behind");
    }

    #[test]
    fn delete_removes_only_the_named_project() {
        let tmp = TempDir::new("delete");
        let store = ProjectStore::in_dir(&tmp.0);
        store.upsert(sample_project("a")).unwrap();
        store.upsert(sample_project("b")).unwrap();
        store.delete("a").unwrap();
        let ids: Vec<String> = store.load().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["b".to_string()]);
    }

    // ---- M4: invalid cache material is preserved, unreadable material is never replaced ----

    #[test]
    fn both_files_invalid_keep_their_original_bytes_through_load_and_two_writes() {
        let tmp = TempDir::new("bothinvalid");
        let store = ProjectStore::in_dir(&tmp.0);
        // Main holds an unknown status (the case a downgrade produces); the backup is not
        // even UTF-8, so any text round trip would change its bytes.
        let backup_bytes: &[u8] = &[0xff, 0xfe, b'[', 0x00, 0x9f];
        fs::write(store.cache_path(), UNKNOWN_STATUS).unwrap();
        fs::write(store.backup_path(), backup_bytes).unwrap();

        assert!(store.load().is_empty(), "load stays graceful");
        assert_eq!(fs::read(store.cache_path()).unwrap(), UNKNOWN_STATUS, "load alone writes nothing");
        assert!(quarantined(&tmp.0, "projects.json").is_empty());

        store.upsert(sample_project("a")).unwrap();
        store.upsert(sample_project("b")).unwrap();

        assert_eq!(ids(&store), vec!["a", "b"]);
        assert_eq!(quarantined(&tmp.0, "projects.json"), vec![UNKNOWN_STATUS.to_vec()]);
        assert_eq!(quarantined(&tmp.0, "projects.json.bak"), vec![backup_bytes.to_vec()]);
    }

    #[test]
    fn corrupt_main_with_a_valid_backup_is_restored_and_the_original_kept() {
        let tmp = TempDir::new("keepmain");
        let store = ProjectStore::in_dir(&tmp.0);
        store.upsert(sample_project("a")).unwrap();
        store.upsert(sample_project("b")).unwrap();
        let backup_before = fs::read(store.backup_path()).unwrap();

        let corrupt: &[u8] = b"[{ \"id\": \"b\", truncated";
        fs::write(store.cache_path(), corrupt).unwrap();

        assert_eq!(ids(&store), vec!["a"], "the backup's projects are returned");
        assert!(try_read_valid_file(&store.cache_path()).is_some(), "main is a valid file again");
        assert_eq!(quarantined(&tmp.0, "projects.json"), vec![corrupt.to_vec()]);
        assert_eq!(fs::read(store.backup_path()).unwrap(), backup_before, "backup untouched");

        // Later writes have nothing more to preserve.
        store.upsert(sample_project("c")).unwrap();
        assert_eq!(quarantined(&tmp.0, "projects.json").len(), 1);
        assert!(quarantined(&tmp.0, "projects.json.bak").is_empty());
    }

    #[test]
    fn quarantine_names_never_collide() {
        let tmp = TempDir::new("names");
        let store = Arc::new(ProjectStore::in_dir(&tmp.0));
        let source = store.cache_path();

        let handles: Vec<_> = (0..8)
            .map(|t| {
                let store = Arc::clone(&store);
                let source = source.clone();
                std::thread::spawn(move || {
                    (0..10)
                        .map(|i| {
                            let payload = format!("payload {} {}", t, i).into_bytes();
                            let path = store.quarantine(&source, &payload).unwrap();
                            (path, payload)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let made: Vec<_> = handles.into_iter().flat_map(|h| h.join().unwrap()).collect();

        let mut paths: Vec<_> = made.iter().map(|(path, _)| path.clone()).collect();
        paths.sort();
        paths.dedup();
        assert_eq!(paths.len(), 80, "every quarantine got its own file");
        for (path, payload) in &made {
            assert_eq!(&fs::read(path).unwrap(), payload, "no quarantine was overwritten");
        }
    }

    #[test]
    fn an_existing_file_is_never_replaced_by_a_new_copy() {
        let tmp = TempDir::new("createnew");
        let path = tmp.0.join("projects.json.corrupt-taken");
        fs::write(&path, b"earlier quarantine").unwrap();

        let err = write_new_file(&path, b"another").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&path).unwrap(), b"earlier quarantine");
    }

    #[test]
    fn a_write_is_refused_when_the_invalid_original_cannot_be_preserved() {
        let tmp = TempDir::new("nopreserve");
        // A quarantine location that cannot be created makes preservation fail for real.
        let store = ProjectStore::in_dir(&tmp.0).with_quarantine_dir(tmp.0.join("missing").join("q"));
        let corrupt: &[u8] = b"{ not a project list";
        fs::write(store.cache_path(), corrupt).unwrap();

        let err = store.upsert(sample_project("a")).unwrap_err();
        assert!(err.to_string().contains("Refusing to replace projects.json"), "{}", err);
        assert_eq!(fs::read(store.cache_path()).unwrap(), corrupt, "original left in place");
        assert!(!store.temp_path().exists(), "no stray temp file");
    }

    #[test]
    fn a_corrupt_main_is_not_replaced_from_the_backup_unless_it_can_be_preserved() {
        let tmp = TempDir::new("norestore");
        let plain = ProjectStore::in_dir(&tmp.0);
        plain.upsert(sample_project("a")).unwrap();
        plain.upsert(sample_project("b")).unwrap();
        let corrupt: &[u8] = b"garbage";
        fs::write(plain.cache_path(), corrupt).unwrap();

        let store = ProjectStore::in_dir(&tmp.0).with_quarantine_dir(tmp.0.join("missing").join("q"));
        assert_eq!(ids(&store), vec!["a"], "load still serves the backup");
        assert_eq!(fs::read(store.cache_path()).unwrap(), corrupt, "main not rewritten");
        assert!(store.upsert(sample_project("c")).is_err(), "writes stay refused");
        assert_eq!(fs::read(store.cache_path()).unwrap(), corrupt);
    }

    #[test]
    fn an_unreadable_main_is_never_overwritten() {
        let tmp = TempDir::new("unreadable");
        let store = ProjectStore::in_dir(&tmp.0);
        // A directory where the file should be cannot be read as a file (not "not found").
        fs::create_dir(store.cache_path()).unwrap();
        fs::write(store.cache_path().join("marker"), b"keep").unwrap();
        let backup = serde_json::to_vec(&vec![sample_project("a")]).unwrap();
        fs::write(store.backup_path(), &backup).unwrap();

        assert_eq!(ids(&store), vec!["a"], "the backup is served read-only");
        let err = store.upsert(sample_project("b")).unwrap_err();
        assert!(err.to_string().contains("cannot be read"), "{}", err);

        assert!(store.cache_path().is_dir(), "main untouched");
        assert_eq!(fs::read(store.cache_path().join("marker")).unwrap(), b"keep");
        assert_eq!(fs::read(store.backup_path()).unwrap(), backup, "backup untouched");
        assert!(quarantined(&tmp.0, "projects.json").is_empty(), "nothing was quarantined");
    }

    #[test]
    fn transient_read_errors_are_retried_but_missing_files_are_not() {
        let path = Path::new("projects.json");
        let valid = br#"[]"#.to_vec();

        let mut attempts = 0;
        let read = read_with_retry(
            path,
            |_| {
                attempts += 1;
                if attempts < 3 {
                    Err(io::Error::from(io::ErrorKind::PermissionDenied))
                } else {
                    Ok(valid.clone())
                }
            },
            Duration::ZERO,
        );
        assert!(matches!(read, CacheRead::Valid(_)));
        assert_eq!(attempts, 3);

        let mut attempts = 0;
        let read = read_with_retry(
            path,
            |_| {
                attempts += 1;
                Err(io::Error::from(io::ErrorKind::NotFound))
            },
            Duration::ZERO,
        );
        assert!(matches!(read, CacheRead::Missing));
        assert_eq!(attempts, 1);
    }

    #[test]
    fn a_persistent_read_error_is_unreadable_not_invalid() {
        let mut attempts = 0;
        let read = read_with_retry(
            Path::new("projects.json"),
            |_| {
                attempts += 1;
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            },
            Duration::ZERO,
        );
        assert!(matches!(read, CacheRead::Unreadable(_)));
        assert_eq!(attempts, READ_ATTEMPTS);
    }

    #[test]
    fn an_unknown_status_is_reported_as_invalid_with_the_reason() {
        let read = read_with_retry(Path::new("p"), |_| Ok(UNKNOWN_STATUS.to_vec()), Duration::ZERO);
        match read {
            CacheRead::Invalid { bytes, reason } => {
                assert_eq!(bytes, UNKNOWN_STATUS);
                assert!(reason.contains("from_the_future"), "reason was: {}", reason);
            }
            _ => panic!("an unknown enum value must be reported as invalid"),
        }
    }
}
