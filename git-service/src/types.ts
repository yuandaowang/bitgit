// Shared types between Rust and Node.js Git service

export interface StatusInfo {
  isGitRepo?: boolean;
  hasRemote?: boolean;
  currentBranch?: string | null;
  upstream?: string | null;
  remoteUrl?: string | null;
  behindCommits?: number;
  remoteCheckedAt?: string | null;
  remoteError?: string | null;
  uncommittedFiles: number;
  untrackedFiles: number;
  modifiedFiles: string[];
  unpushedCommits: number;
  remoteBranches: string[];
}

// Omitting selectedFiles permits pushing existing commits only; never implies stage-all.
export interface PublishOptions {
  selectedFiles?: string[];
  allowWarnings?: boolean;
}

// Why a sync did not (fully) succeed, or what it did. Only 'up-to-date', 'fast-forwarded' and
// 'published' accompany success: true.
export type SyncOutcome =
  | 'up-to-date'
  | 'fast-forwarded'
  | 'published'
  | 'needs-selection'
  | 'dirty-behind'
  | 'diverged'
  | 'conflicted'
  | 'blocked'
  | 'fetch-failed'
  | 'push-failed'
  | 'failed';

export interface SyncResult {
  success: boolean;
  message: string;
  committed?: number;   // files committed by this call
  pushed?: number;      // commits transferred to the remote by this call
  pulled?: number;      // commits fast-forwarded from the upstream by this call
  merged?: string[];
  deleted?: string[];
  errors?: string[];
  outcome?: SyncOutcome;
  issues?: FileValidationIssue[];
}

export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'conflicted';

// One pending path. `staged`/`unstaged` are the index and working-tree states; an untracked file
// has neither. A path can be staged and unstaged at once (partially staged).
export interface FileChangeInfo {
  path: string;
  staged: FileChangeKind | null;
  unstaged: FileChangeKind | null;
  untracked: boolean;
  conflicted: boolean;
}

// Advanced Git feature types
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

export interface StashInfo {
  index: number;
  hash: string;
  message: string;
  date: string;
}

export interface TagInfo {
  name: string;
}

// Analytics types
export interface AnalyticsSnapshotParams {
  historySince: string; // YYYY-MM-DD; bounds commitDates
  recentSince: string;  // YYYY-MM-DD; bounds recentCommits
  recentLimit: number;
}

export interface AnalyticsCommit {
  hash: string;
  author: string;
  email: string;
  date: string;
  message: string;
  branch: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface BranchStaleness {
  name: string;
  daysSinceLastCommit: number;
  isRemote: boolean;
  lastCommitHash: string;
  lastCommitDate: string;
}

export interface AnalyticsSnapshot {
  commitDates: string[];            // author date (ISO 8601) of every HEAD commit since historySince
  recentCommits: AnalyticsCommit[]; // newest first, with file statistics
  branches: BranchStaleness[];
  daysSinceLastCommit: number | null;
  tagCount: number;
  stashCount: number;
}

// One entry per requested repository, so one unreadable repository cannot fail the whole dashboard.
export type AnalyticsSnapshotResult =
  | { repoPath: string; snapshot: AnalyticsSnapshot }
  | { repoPath: string; error: string };

// Pre-sync validation types
export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface FileValidationIssue {
  filePath: string;
  severity: ValidationSeverity;
  reason: string;
  sizeBytes?: number;
  sizeMB?: number;
  suggestion?: string;
  gitignorePattern?: string;
}

export interface PreSyncValidation {
  canProceed: boolean;          // false if there are errors that will definitely fail
  hasWarnings: boolean;         // true if there are warnings but can proceed
  totalStagedSize: number;      // total size of staged changes in bytes
  totalStagedSizeMB: number;    // total size in MB for display
  issues: FileValidationIssue[];
  suggestedGitignore: string[]; // patterns to add to .gitignore
}

export type GitOperation =
  | { type: 'checkStatus'; repoPath: string }
  | { type: 'validateBeforeSync'; repoPath: string }
  | { type: 'pushLocal'; repoPath: string }
  | { type: 'mergeBranches'; repoPath: string; branches: string[] }
  | { type: 'pullBranches'; repoPath: string; branches: string[] }
  | { type: 'fullSync'; repoPath: string }
  // Advanced operations
  | { type: 'getBranches'; repoPath: string }
  | { type: 'createBranch'; repoPath: string; branchName: string; checkout: boolean }
  | { type: 'switchBranch'; repoPath: string; branchName: string }
  | { type: 'deleteBranch'; repoPath: string; branchName: string; force: boolean }
  | { type: 'getCommitHistory'; repoPath: string; limit: number }
  | { type: 'getDiff'; repoPath: string; filePath?: string }
  | { type: 'createStash'; repoPath: string; message?: string }
  | { type: 'listStashes'; repoPath: string }
  | { type: 'applyStash'; repoPath: string; index: number }
  | { type: 'popStash'; repoPath: string }
  | { type: 'dropStash'; repoPath: string; index: number }
  | { type: 'createTag'; repoPath: string; tagName: string; message?: string }
  | { type: 'listTags'; repoPath: string }
  | { type: 'pushTag'; repoPath: string; tagName: string }
  | { type: 'pushAllTags'; repoPath: string }
  | { type: 'deleteTag'; repoPath: string; tagName: string }
  | { type: 'cherryPick'; repoPath: string; commitHash: string }
  | { type: 'getCurrentBranch'; repoPath: string }
  // Analytics operations
  | { type: 'getAnalyticsSnapshots'; repoPaths: string[]; params: AnalyticsSnapshotParams };
