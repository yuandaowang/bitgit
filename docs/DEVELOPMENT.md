# 🛠️ BitGit Development Guide

## Quick Reference

### Build Commands
```bash
# Run development mode
npm run tauri:dev

# Build individual components
npm run build                    # Frontend
cd git-service && npm run build  # Git service
cd src-tauri && cargo build      # Rust backend

# Build everything
npm run build && \
cd git-service && npm run build && cd .. && \
cd src-tauri && cargo build && cd ..
```

### Development Workflow

1. **Make changes** to any component
2. **Rebuild** the affected component
3. **Restart** the app (Ctrl+C then `npm run tauri:dev`)
4. **Test** your changes

---

## Architecture Overview

```
┌─────────────────────────────────────────┐
│         React Frontend (src/)            │
│  - Dashboard, Settings, RepositoryCard  │
│  - Zustand store for state              │
│  - Tailwind CSS styling                 │
└──────────────┬──────────────────────────┘
               │ Tauri IPC (invoke())
┌──────────────▼──────────────────────────┐
│      Rust Backend (src-tauri/src/)      │
│  - commands.rs: IPC handlers            │
│  - git_service.rs: Node.js manager      │
│  - credentials.rs: Token storage        │
│  - scanner.rs: Repo discovery           │
└──────────────┬──────────────────────────┘
               │ stdin/stdout IPC (JSON)
┌──────────────▼──────────────────────────┐
│   Node.js Git Service (git-service/)    │
│  - ipc-server.ts: Command handling      │
│  - git-operations.ts: simple-git        │
│  - github-api.ts: Octokit               │
└──────────────┬──────────────────────────┘
               │ Library calls
┌──────────────▼──────────────────────────┐
│        Git CLI + GitHub API             │
└─────────────────────────────────────────┘
```

---

## Key Files

### Frontend
- `src/App.tsx` - Main app, imports Dashboard
- `src/components/Dashboard.tsx` - Main view, repository list
- `src/components/RepositoryCard.tsx` - Individual repo display
- `src/components/SettingsModal.tsx` - Settings UI
- `src/stores/useAppStore.ts` - Zustand state management
- `src/types/index.ts` - TypeScript type definitions

### Backend (Rust)
- `src-tauri/src/main.rs` - Entry point, command registration
- `src-tauri/src/commands.rs` - Tauri command implementations
- `src-tauri/src/git_service.rs` - Node.js process manager
- `src-tauri/src/credentials.rs` - Windows Credential Manager
- `src-tauri/src/scanner.rs` - Repository scanning
- `src-tauri/src/models.rs` - Rust data structures

### Git Service (Node.js)
- `git-service/src/index.ts` - Entry point, imports IPC server
- `git-service/src/ipc-server.ts` - IPC communication layer
- `git-service/src/git-operations.ts` - Git commands (simple-git)
- `git-service/src/github-api.ts` - GitHub API (Octokit)
- `git-service/src/types.ts` - Shared type definitions

---

## Adding Features

### Add a New Tauri Command

**1. Define in Rust (`src-tauri/src/commands.rs`):**
```rust
#[tauri::command]
pub async fn my_new_command(param: String) -> Result<String, String> {
    // Your implementation
    Ok(format!("Processed: {}", param))
}
```

**2. Register (`src-tauri/src/main.rs`):**
```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands
    my_new_command,
])
```

**3. Call from Frontend:**
```typescript
import { invoke } from '@tauri-apps/api/tauri';

const result = await invoke<string>('my_new_command', {
  param: 'value'
});
```

**4. Update store if needed (`src/stores/useAppStore.ts`):**
```typescript
myNewAction: async (value: string) => {
  const result = await invoke('my_new_command', { param: value });
  // Update state if needed
}
```

### Add a New Git Operation

**1. Implement in Git Service (`git-service/src/git-operations.ts`):**
```typescript
export class GitOperations {
  async myGitOperation(): Promise<MyResult> {
    const result = await this.git.log();
    return { commits: result.all };
  }
}
```

**2. Add IPC Handler (`git-service/src/ipc-server.ts`):**
```typescript
case 'myGitOperation': {
  const { repoPath } = command.payload;
  const git = new GitOperations(repoPath);
  const result = await git.myGitOperation();
  return { id: command.id, success: true, data: result };
}
```

**3. Add Rust Wrapper (`src-tauri/src/git_service.rs`):**
```rust
pub fn my_git_operation(&self, repo_path: &str) -> Result<MyResult> {
    let payload = serde_json::json!({ "repoPath": repo_path });
    let result = self.execute("myGitOperation", payload)?;
    let parsed: MyResult = serde_json::from_value(result)?;
    Ok(parsed)
}
```

**4. Add Tauri Command (`src-tauri/src/commands.rs`):**
```rust
#[tauri::command]
pub async fn my_git_operation(repo_path: String) -> Result<MyResult, String> {
    let service = get_git_service()?;
    let result = service.my_git_operation(&repo_path)
        .map_err(|e| format!("Operation failed: {}", e))?;
    Ok(result)
}
```

---

## IPC Protocol

### Rust → Node.js Communication

**Message Format (stdin):**
```json
{
  "id": "cmd_123",
  "type": "checkStatus",
  "payload": {
    "repoPath": "C:\\Projects\\my-repo"
  }
}
```

**Response Format (stdout):**
```json
{
  "id": "cmd_123",
  "success": true,
  "data": {
    "uncommittedFiles": 5,
    "remoteBranches": ["feature-x"]
  }
}
```

**Error Response:**
```json
{
  "id": "cmd_123",
  "success": false,
  "error": "Repository not found"
}
```

### Available IPC Commands

| Command | Payload | Returns |
|---------|---------|---------|
| `ping` | `{}` | `"pong"` |
| `setGithubToken` | `{token: string}` | `null` |
| `checkStatus` | `{repoPath: string}` | `StatusInfo` |
| `pushLocal` | `{repoPath: string}` | `{committed: number, pushed: boolean}` |
| `mergeBranches` | `{repoPath: string, branches: string[]}` | `{merged: string[]}` |
| `fullSync` | `{repoPath: string}` | `FullSyncResult` |
| `verifyGithubToken` | `{token: string}` | `{username: string, valid: boolean}` |

---

## Type System

### Frontend Types (`src/types/index.ts`)
```typescript
interface Repository {
  id: string;
  name: string;
  localPath: string;
  githubUrl: string | null;
  status: RepositoryStatus;
}

interface RepositoryStatus {
  uncommittedFiles: number;
  remoteBranches: string[];
  syncStatus: 'synced' | 'local_changes' | 'remote_branches' | 'both';
}
```

### Rust Types (`src-tauri/src/models.rs`)
```rust
#[derive(Serialize, Deserialize)]
pub struct Repository {
    pub id: String,
    pub name: String,
    pub local_path: String,
    pub github_url: Option<String>,
    pub status: RepositoryStatus,
}
```

**Important:** Keep Rust and TypeScript types in sync!

---

## State Management

### Zustand Store (`src/stores/useAppStore.ts`)

```typescript
interface AppState {
  // State
  repositories: Repository[];
  isLoading: boolean;

  // Actions
  loadRepositories: () => Promise<void>;
  syncRepository: (id: string, action: SyncAction) => Promise<void>;
}

// Usage in components
const { repositories, syncRepository } = useAppStore();
```

---

## Styling

### Tailwind CSS

**Status Colors:**
```typescript
// Green - Synced
className="border-green-500 bg-green-100 text-green-700"

// Yellow - Local changes
className="border-yellow-500 bg-yellow-100 text-yellow-700"

// Orange - Remote branches
className="border-orange-500 bg-orange-100 text-orange-700"

// Red - Both issues
className="border-red-500 bg-red-100 text-red-700"
```

**Common Patterns:**
```typescript
// Button
className="px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700"

// Card
className="bg-white rounded-lg shadow-sm border-l-4 border-green-500"

// Input
className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
```

---

## Error Handling

### Best Practices

**Rust:**
```rust
// Use Result for recoverable errors
pub fn operation() -> Result<T, String> {
    something().map_err(|e| format!("Failed: {}", e))?;
    Ok(result)
}

// Propagate errors up the chain
let service = get_git_service()?;
```

**TypeScript:**
```typescript
// Catch and show user-friendly messages
try {
  await invoke('operation');
  toast.success('Operation completed');
} catch (error: any) {
  toast.error(`Failed: ${error}`);
}
```

**Git Service:**
```typescript
// Return structured errors
return {
  id: command.id,
  success: false,
  error: error.message
};
```

---

## Debugging

### Frontend (React)
1. Open DevTools: F12
2. Console tab for logs
3. Network tab for Tauri invoke calls
4. React DevTools for component state

### Backend (Rust)
1. Logs appear in terminal
2. Use `eprintln!` for debug output
3. Look for `[Rust]` prefix

### Git Service (Node.js)
1. Logs to stderr (appears in terminal)
2. Use `console.error` for debug
3. Look for `[GitService]` prefix

### IPC Communication
```rust
// Rust: Log commands
eprintln!("[Rust] Sending command: {:?}", command);

// Node: Log responses
console.error(`[GitService] Response: ${JSON.stringify(response)}`);
```

---

## Testing

### Manual Testing Checklist

**Settings:**
- [ ] Can open Settings modal
- [ ] Can save GitHub token
- [ ] Token verification works
- [ ] Can select directories
- [ ] Can scan for repositories
- [ ] Found repos are displayed

**Dashboard:**
- [ ] Repositories appear in list
- [ ] Status colors are correct
- [ ] Uncommitted file count shows
- [ ] Remote branches are listed
- [ ] Last checked time displays

**Operations:**
- [ ] Push Local commits and pushes
- [ ] Merge Remote merges branches
- [ ] Full Sync does both
- [ ] Error messages are clear
- [ ] Success toasts appear

**Edge Cases:**
- [ ] No internet connection
- [ ] Invalid GitHub token
- [ ] Empty repository
- [ ] Repository with conflicts
- [ ] Very large repository

---

## Common Issues

### "Git service failed to start"
**Cause:** Node.js not found or Git service not built
**Fix:**
```bash
cd git-service && npm run build && cd ..
node --version  # Check Node.js installed
```

### "Failed to verify token"
**Cause:** Invalid token format or expired
**Fix:** Generate new token at https://github.com/settings/tokens with `repo` scope

### "Repository not found"
**Cause:** Path doesn't exist or not a Git repo
**Fix:** Verify path has `.git` folder

### Build errors
**Cause:** Dependencies out of sync
**Fix:**
```bash
npm install
cd git-service && npm install && cd ..
```

---

## Performance

### Optimization Tips

**Frontend:**
- Use `React.memo()` for expensive components
- Debounce search/filter inputs
- Virtual scrolling for large repo lists

**Backend:**
- Batch repository status checks
- Cache results with TTL
- Use async operations

**Git Service:**
- Reuse Git instances where possible
- Batch GitHub API calls
- Handle large repositories efficiently

---

## Security

### Important Rules

1. **Never commit tokens** - Use Windows Credential Manager
2. **Validate all inputs** - Sanitize paths and commands
3. **Use HTTPS for GitHub** - Don't use SSH without user setup
4. **Escape command arguments** - Prevent injection attacks
5. **Check token scopes** - Require `repo` scope minimum

---

## Dependencies

### Frontend
- react, react-dom
- @tauri-apps/api
- zustand
- react-hot-toast
- @headlessui/react
- lucide-react
- tailwindcss

### Backend (Rust)
- tauri
- serde, serde_json
- tokio
- anyhow
- walkdir
- once_cell
- chrono
- windows (for Credential Manager)

### Git Service (Node.js)
- simple-git
- @octokit/rest

---

## Git Workflow

### Feature Development

```bash
# 1. Create feature branch
git checkout -b feature/my-feature

# 2. Make changes
# ... code ...

# 3. Test thoroughly
npm run tauri:dev

# 4. Build everything
npm run build
cd git-service && npm run build && cd ..
cd src-tauri && cargo build && cd ..

# 5. Commit
git add .
git commit -m "Add: my feature"

# 6. Push
git push origin feature/my-feature
```

### Commit Message Convention

- `Add: new feature` - New functionality
- `Fix: bug description` - Bug fixes
- `Update: component name` - Improvements
- `Refactor: area` - Code restructuring
- `Docs: what changed` - Documentation
- `Build: dependency/config` - Build changes

---

## Production Build

### Create Installer

```bash
# Build production version
npm run tauri:build

# Output location
# src-tauri/target/release/bundle/nsis/BitGit_0.1.0_x64-setup.exe
```

### Bundle Checklist
- [ ] All dependencies bundled
- [ ] Icons included
- [ ] Node.js runtime bundled
- [ ] Git service compiled
- [ ] Windows manifest included

### Automatic updates

Since 1.1.2 the app asks `https://github.com/yuandaowang/bitgit/releases/latest/download/latest.json`
at startup (Tauri's built-in updater, `tauri.updater` in `tauri.conf.json`) and offers to install a
newer version. Installs of 1.1.1 and earlier have no updater and must download once by hand.

- Artifacts are signed with the minisign key at `~/.tauri/bitgit.key`; its public half is
  `tauri.updater.pubkey`. The private key is the `TAURI_PRIVATE_KEY` repository secret and has no
  password. Losing it means shipped installs never accept another update, because the public key is
  baked into every binary: back it up off this machine and never commit it.
- `release.yml` builds `.nsis.zip`, `.app.tar.gz` and `.AppImage.tar.gz` bundles with `.sig` files
  and uploads `latest.json`. The release is created as a draft and published only after every
  platform has uploaded, so `releases/latest` never points at an incomplete release.
- Updates reach Windows installs, macOS app bundles and the Linux AppImage. Debian and RPM installs
  are outside Tauri 1's updater and keep using the package files.

---

## Resources

### Documentation
- Tauri: https://tauri.app/v1/guides/
- React: https://react.dev/
- simple-git: https://github.com/steveukx/git-js
- Octokit: https://octokit.github.io/rest.js/

### Tools
- Rust: https://rustup.rs/
- Node.js: https://nodejs.org/
- Git: https://git-scm.com/

---

## Contributors

When contributing:
1. Read this guide
2. Follow the code style
3. Test your changes
4. Update documentation
5. Create clear commit messages

---

**Happy coding! 🚀**
