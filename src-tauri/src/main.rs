// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_data;
mod app_settings;
mod commands;
mod credentials;
mod git_service;
mod gitignore;
mod instance_lock;
mod login_path;
mod models;
mod project_cache;
mod project_sync;
mod recovery_request;
mod scanner;

use commands::*;

fn main() {
    // Held until the process exits. Keyed on the data directory, so an isolated smoke run never
    // collides with the installed app. The recovery CLI never takes it: idle saves run beside the GUI.
    let _instance = match app_data::config_dir() {
        Ok(data_dir) => match instance_lock::acquire(&data_dir) {
            Ok(lock) => Some(lock),
            Err(instance_lock::AlreadyRunning) => {
                tauri::api::dialog::blocking::message(
                    None::<&tauri::Window>,
                    "BitGit",
                    "BitGit is already running. Close the other window first.",
                );
                return;
            }
        },
        Err(error) => {
            // Fail open like instance_lock::acquire; the commands report the data directory error.
            eprintln!("BitGit instance lock unavailable, starting without it: {error:#}");
            None
        }
    };

    tauri::Builder::default()
        .setup(|_app| {
            // Windows keeps finding the script next to the executable: there the resolver would
            // hand Node a \\?\ verbatim path.
            #[cfg(not(windows))]
            match _app.path_resolver().resolve_resource("../git-service/dist/index.js") {
                Some(script) => git_service::set_bundled_script(script),
                // GitService::new reports the missing script when a command needs the service.
                None => eprintln!("[Rust] The app bundle's resource directory could not be resolved"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_repositories,
            sync_repository,
            check_repository_status,
            save_github_token,
            get_stored_github_credentials,
            get_github_token,
            has_github_token,
            verify_github_token,
            scan_directories,
            add_repositories,
            fetch_github_repos,
            // New project management commands
            load_projects,
            create_project,
            update_project,
            delete_project,
            check_project_status,
            // Project actions
            open_in_editor,
            open_in_terminal,
            detect_installed_editors,
            save_editor_settings,
            load_editor_settings,
            clone_repository,
            create_github_repository,
            validate_before_sync,
            add_gitignore_patterns,
            sync_project,
            // Recovery
            recovery_command,
            // Advanced Git features
            git_get_branches,
            git_create_branch,
            git_switch_branch,
            git_delete_branch,
            git_get_commit_history,
            git_get_diff,
            git_get_file_changes,
            git_create_stash,
            git_list_stashes,
            git_apply_stash,
            git_pop_stash,
            git_drop_stash,
            git_create_tag,
            git_list_tags,
            git_push_tag,
            git_push_all_tags,
            git_delete_tag,
            git_cherry_pick,
            git_get_current_branch,
            // Project Management (Priority 3)
            update_project_metadata,
            toggle_project_favorite,
            toggle_project_archived,
            set_project_labels,
            apply_project_template,
            increment_project_stats,
            // Analytics (Priority 1)
            generate_analytics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
