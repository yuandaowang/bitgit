// Core data models for BitGit

// Main Project interface - can have GitHub, Local, both, or neither
export interface Project {
  id: string;
  name: string;

  // GitHub (optional)
  githubOwner: string | null;
  githubRepo: string | null;
  githubUrl: string | null;

  // Local (optional)
  localPath: string | null;

  // Overall project state
  projectStatus: ProjectStatus;

  // Git status of the local folder; null until the first check
  gitStatus: GitStatus | null;

  // Timestamps
  createdAt: string;
  lastSynced: string | null;

  // Priority 3: Project Management Features
  description?: string | null;          // Project notes/description
  archived?: boolean;                   // Archive status (hide without deleting)
  favorite?: boolean;                   // Pinned/favorited projects
  labels?: string[];                    // User labels; absent on older saved projects
  lastActivity?: string | null;         // Last activity timestamp
  statistics?: ProjectStatistics | null; // Usage statistics
  template?: string | null;             // Template used to initialize
}

// Overall project configuration state
export type ProjectStatus =
  | 'not_configured'     // Neither GitHub nor Local
  | 'github_only'        // Has GitHub, no Local
  | 'local_only'         // Has Local, no GitHub
  | 'ready'              // Both linked, needs status check
  | 'synced'             // Both linked, everything in sync
  | 'needs_push'         // Both linked, has local changes
  | 'needs_merge'        // Both linked, has remote branches
  | 'needs_sync';        // Both linked, has both issues

// Git status of a project's local folder (mirrors the native GitStatus)
export interface GitStatus {
  isGitRepo: boolean;
  hasRemote: boolean;

  // Local state
  uncommittedFiles: number;
  untrackedFiles: number;
  modifiedFiles: string[];
  currentBranch?: string | null;   // null when detached or not a repository
  upstream?: string | null;        // e.g. "origin/main"; null when none is configured
  remoteUrl?: string | null;       // fetch URL of the remote used for this check

  // Remote state
  unpushedCommits: number;         // ahead of the upstream
  behindCommits?: number;          // upstream commits missing locally
  remoteBranches: string[];
  remoteCheckedAt?: string | null; // last successful read of the remote; never set by a failed check
  remoteError?: string | null;     // why the remote could not be read, or the whole check failed

  // Sync state; `unavailable` means nothing can be claimed about the remote
  syncStatus:
    | 'synced'
    | 'local_changes'
    | 'remote_branches'
    | 'both'
    | 'not_connected'
    | 'behind'
    | 'diverged'
    | 'unavailable';
  lastChecked: string;
}

// Legacy type alias for compatibility
export type Repository = Project;
export type RepositoryStatus = GitStatus;

export interface RepositorySettings {
  defaultBranch: string;
  autoSync: boolean;
  excludeFromBatch: boolean;
}

export interface OperationLog {
  id: string;
  timestamp: Date;
  action: 'push_local' | 'merge_branches' | 'full_sync' | 'add_to_github' | 'check_status';
  result: 'success' | 'error' | 'partial';
  message: string;
  details?: string;
}

// Omitting `selectedFiles` pushes existing commits only; it never means "stage everything".
// `allowWarnings` lets one attempt publish despite reviewed warnings; blocking issues stay blocked.
export type PublishAction =
  | { type: 'push_local'; commitMessage?: string; commitDescription?: string; selectedFiles?: string[]; allowWarnings?: boolean }
  | { type: 'full_sync'; commitMessage?: string; commitDescription?: string; selectedFiles?: string[]; allowWarnings?: boolean };

export type SyncAction =
  | PublishAction
  | { type: 'merge_branches'; branches: string[] }
  | { type: 'pull_branches'; branches: string[] };

export interface SyncResult {
  success: boolean;
  message: string;
  details: {
    committed?: number;
    pushed?: number;
    pulled?: number;
    merged?: string[];
    deleted?: string[];
    errors?: string[];
  };
  newStatus?: RepositoryStatus;
}

// Result of re-reading one project's local Git state. `unavailable` means the project was
// checked but the answer is incomplete, so it must not be presented as up to date.
export type RefreshOutcome =
  | { status: 'ok'; project: Project }
  | { status: 'unavailable'; project: Project; cause: 'not_git' | 'remote'; reason: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

export interface RefreshSummary {
  checked: number;
  ok: number;
  unavailable: number;
  failed: number;
  skipped: number;
}

export type BulkOutcome = 'published' | 'up_to_date' | 'needs_review' | 'blocked' | 'failed' | 'skipped';

export interface BulkProjectResult {
  projectId: string;
  name: string;
  outcome: BulkOutcome;
  message: string;
}

export interface AppSettings {
  github: GitHubSettings;
  scanning: ScanSettings;
  ui: UISettings;
}

export interface GitHubSettings {
  username: string;
  hasToken: boolean;
}

export interface ScanSettings {
  directories: string[];
  depth: number;
  excludePatterns: string[];
}

export interface UISettings {
  theme: 'light' | 'dark' | 'system';
  refreshInterval: number;
  showNotifications: boolean;
  editor: EditorConfig;
}

// Editor configuration types
export type EditorPreset = 'vscode' | 'cursor' | 'sublime' | 'custom';

export interface EditorConfig {
  preset: EditorPreset;
  customCommand?: string;
}

export interface EditorAvailability {
  vscode: boolean;
  cursor: boolean;
  sublime: boolean;
}

// Advanced Git Features Types
export interface BranchInfo {
  name: string;
  current: boolean;
  commit: string;
  label: string;
  isRemote: boolean;
}

export interface CommitInfo {
  hash: string;
  author: string;
  email: string;
  date: string;
  message: string;
  body: string;
  refs: string;
}

// staged = HEAD to index, unstaged = index to working tree, untracked = whole new file.
export type DiffScope = 'staged' | 'unstaged' | 'untracked';

export interface DiffInfo {
  fileName: string;
  changes: Array<{
    line: number;
    type: 'add' | 'remove' | 'context';
    content: string;
  }>;
  scope?: DiffScope;
  binary?: boolean;     // changes is empty because the content is not text
  truncated?: boolean;  // changes was cut at the preview limit
}

export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'conflicted';

// One pending path. A path can be staged and unstaged at once (partially staged);
// an untracked file has neither.
export interface FileChangeInfo {
  path: string;
  staged: FileChangeKind | null;
  unstaged: FileChangeKind | null;
  untracked: boolean;
  conflicted: boolean;
}

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface FileValidationIssue {
  filePath: string;
  severity: ValidationSeverity;
  reason: string;
  sizeBytes?: number;
  sizeMb?: number;
  suggestion?: string;
  gitignorePattern?: string;
}

// `canProceed` is false when anything blocking was found; `hasWarnings` means the
// caller must pass `allowWarnings` for a publish to go through.
export interface PreSyncValidation {
  canProceed: boolean;
  hasWarnings: boolean;
  totalStagedSize: number;
  totalStagedSizeMb: number;
  issues: FileValidationIssue[];
  suggestedGitignore: string[];
}

export interface StashInfo {
  index: number;
  hash: string;
  message: string;
  date: string;
}

export interface TagInfo {
  name: string;
}

// Project Management Types (Priority 3)
export interface ProjectStatistics {
  totalSyncs: number;
  totalCommits: number;
  totalPushes: number;
  totalMerges: number;
  totalPulls: number;
  lastSyncDate: string | null;
  lastCommitDate: string | null;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  gitignore: string;
  readme?: string;
  additionalFiles?: { path: string; content: string }[];
}

// Priority 6: Performance & Reliability Types
export interface QueuedOperation {
  id: string;
  projectId: string;
  projectName: string;
  action: SyncAction;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  maxAttempts: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface OperationQueueState {
  queue: QueuedOperation[];
  isProcessing: boolean;
  maxConcurrent: number;
}

export interface RetryConfig {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier: number;
}

// ===== Priority 1: Dashboard Analytics & Insights Types =====

// Dashboard Overview Panel
export interface DashboardOverview {
  totalProjects: number;
  activeProjects: number;          // Recently synced
  needsAttention: number;           // Has uncommitted changes or pending PRs

  // Time-based commit counts
  commitsToday: number;
  commitsThisWeek: number;
  commitsThisMonth: number;

  // Aggregate stats
  totalBranches: number;
  totalStashes: number;
  totalTags: number;

  // Most active project
  mostActiveProject: {
    id: string;
    name: string;
    commitCount: number;
  } | null;
}

// Activity Timeline Entry
export interface ActivityEntry {
  id: string;
  projectId: string;
  projectName: string;
  projectColor: string;            // For visual grouping

  // Commit details
  commitHash: string;
  commitMessage: string;
  author: string;
  email: string;
  date: string;                    // ISO timestamp

  // Additional context
  branch: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

// Activity Timeline with filtering
export interface ActivityTimeline {
  entries: ActivityEntry[];
}

// Repository Health Indicator
export interface HealthIndicator {
  projectId: string;
  projectName: string;

  // Health metrics
  daysSinceLastCommit: number | null;
  uncommittedChangesDuration: number | null;  // Hours since first change
  staleBranches: StaleBranchInfo[];

  // Severity levels
  healthStatus: 'healthy' | 'attention' | 'warning' | 'critical';
  warnings: string[];

  // Dependencies (future enhancement)
  outdatedDependencies?: number;
}

export interface StaleBranchInfo {
  name: string;
  daysSinceLastCommit: number;
  isRemote: boolean;
}

// Contribution Heatmap
export interface ContributionHeatmap {
  // Map of date (YYYY-MM-DD) to contribution count
  dailyContributions: Record<string, DailyContribution>;

  // Date range
  startDate: string;
  endDate: string;

  // Summary stats
  totalContributions: number;
  currentStreak: number;
  longestStreak: number;

  // Most productive day
  mostProductiveDay: {
    date: string;
    count: number;
  } | null;
}

export interface DailyContribution {
  date: string;                    // YYYY-MM-DD
  count: number;                   // Number of commits
  projects: string[];              // Project IDs with activity
  level: 0 | 1 | 2 | 3 | 4;       // Intensity level (0=none, 4=most)
}

// Combined Analytics Data
export interface AnalyticsData {
  overview: DashboardOverview;
  timeline: ActivityTimeline;
  health: HealthIndicator[];
  heatmap: ContributionHeatmap;

  // Metadata
  lastUpdated: string;
  generatedAt: string;
}

// Analytics Configuration
export interface AnalyticsConfig {
  // Timeline settings
  timelineLimit: number;           // Max entries to fetch
  timelineDays: number;            // Days to look back

  // Health thresholds
  healthThresholds: {
    staleCommitDays: number;       // Days before considering stale
    uncommittedHours: number;      // Hours before warning
    staleBranchDays: number;       // Days before branch is stale
  };

  // Heatmap settings
  heatmapMonths: number;           // Months to display

  // Auto-refresh
  autoRefresh: boolean;
  refreshIntervalMinutes: number;
}

// Default analytics configuration
export const DEFAULT_ANALYTICS_CONFIG: AnalyticsConfig = {
  timelineLimit: 100,
  timelineDays: 30,
  healthThresholds: {
    staleCommitDays: 7,
    uncommittedHours: 24,
    staleBranchDays: 30,
  },
  heatmapMonths: 12,
  autoRefresh: true,
  refreshIntervalMinutes: 15,
};

// Predefined templates
export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'blank',
    name: 'Blank',
    description: 'Empty project with no templates',
    gitignore: '',
  },
  {
    id: 'node',
    name: 'Node.js',
    description: 'Node.js project with common ignores',
    gitignore: `# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Environment
.env
.env.local
.env.*.local

# Build
dist/
build/
*.log

# IDE
.vscode/
.idea/
*.swp
*.swo
.DS_Store`,
  },
  {
    id: 'python',
    name: 'Python',
    description: 'Python project with virtual env ignores',
    gitignore: `# Byte-compiled / optimized
__pycache__/
*.py[cod]
*$py.class

# Virtual environments
venv/
env/
ENV/
.venv

# Distribution / packaging
dist/
build/
*.egg-info/

# IDE
.vscode/
.idea/
*.swp
.DS_Store

# Testing
.pytest_cache/
.coverage
htmlcov/`,
  },
  {
    id: 'react',
    name: 'React',
    description: 'React/Vite project setup',
    gitignore: `# Dependencies
node_modules/
.pnp/
.pnp.js

# Production
/build
/dist

# Environment
.env
.env.local
.env.*.local

# Logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# IDE
.vscode/
.idea/
.DS_Store

# Testing
coverage/`,
  },
  {
    id: 'rust',
    name: 'Rust',
    description: 'Rust project with Cargo ignores',
    gitignore: `# Cargo
/target/

# IDE
.vscode/
.idea/
*.swp
.DS_Store

# OS
Thumbs.db`,
  },
  {
    id: 'java',
    name: 'Java',
    description: 'Java/Maven/Gradle project',
    gitignore: `# Compiled class files
*.class

# Package Files
*.jar
*.war
*.ear

# Maven
target/
pom.xml.tag
pom.xml.releaseBackup
pom.xml.versionsBackup

# Gradle
.gradle/
build/

# IDE
.vscode/
.idea/
*.iml
.DS_Store`,
  },
];
