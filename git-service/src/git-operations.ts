import { simpleGit, SimpleGit, StatusResult, LogResult, DiffResult } from 'simple-git';
import { spawn } from 'child_process';
import {
  StatusInfo, SyncResult, SyncOutcome, PublishOptions, BranchInfo, CommitInfo, StashInfo, TagInfo,
  DiffInfo, DiffScope, FileChangeInfo, FileChangeKind, PreSyncValidation, FileValidationIssue, ValidationSeverity,
  AnalyticsCommit, AnalyticsSnapshot, AnalyticsSnapshotParams, AnalyticsSnapshotResult, BranchStaleness,
} from './types.js';
import { exclusionReason, MAX_FILE_BYTES } from './recovery-policy.js';
import * as fs from 'fs';
import * as path from 'path';

const NETWORK_TIMEOUT_MS = 10 * 60 * 1000; // pushes
const FETCH_TIMEOUT_MS = 2 * 60 * 1000;
const STATUS_FETCH_TIMEOUT_MS = 30 * 1000; // status must stay responsive when the remote is unreachable
const ANALYTICS_TIMEOUT_MS = 30 * 1000; // per git command; one pathological repository must not stall the dashboard
const ANALYTICS_PARALLEL_REPOS = 6;
const BLOB_CHUNK_BYTES = 32 * 1024 * 1024; // bounds memory while scanning outgoing blobs
const TAG_PUSH_BATCH = 100; // refspecs per push, so a long tag list cannot overflow the command line
const DIFF_PREVIEW_MAX_BYTES = 1024 * 1024;
const DIFF_PREVIEW_MAX_LINES = 5000;

interface GitRun { code: number; stdout: Buffer; stderr: string; }
interface GitRunOptions { input?: string | Buffer; timeoutMs?: number; readOnly?: boolean; }

// Arguments are an array (no shell). Literal pathspecs keep selected names from acting as globs or
// pathspec magic; readOnly avoids the index refresh write that plain `git status` performs.
function runGit(cwd: string, args: string[], options: GitRunOptions = {}): Promise<GitRun> {
  const fullArgs = [...(options.readOnly ? ['--no-optional-locks'] : []), '--literal-pathspecs', '-c', 'core.quotepath=false', ...args];
  return new Promise((resolve, reject) => {
    // Off Windows a timed git leads its own process group, so the timeout reaches its transport helpers too.
    const ownGroup = process.platform !== 'win32' && Boolean(options.timeoutMs);
    const child = spawn('git', fullArgs, { cwd, windowsHide: true, detached: ownGroup, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      finish();
    };
    // Settle at the deadline instead of waiting for 'close': a surviving transport helper can hold the pipes open.
    const timer = options.timeoutMs ? setTimeout(() => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else if (ownGroup && child.pid) {
        // SIGTERM, not SIGKILL: git removes its lock files on SIGTERM.
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } // The group is gone: signal the leader.
      } else child.kill();
      settle(() => reject(new Error(`git ${args[0]} timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s`)));
    }, options.timeoutMs) : null;
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => { /* git exited before reading its input; its exit code reports the failure */ });
    child.on('error', (error) => settle(() => reject(new Error(`Could not run git: ${error.message}`))));
    child.on('close', (code) => settle(() => resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') })));
    child.stdin.end(options.input);
  });
}

// Credentials embedded in remote URLs must never reach logs, errors or results.
function redactSecrets(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1***@');
}

export function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function gitMessage(run: GitRun): string {
  const text = (run.stderr.trim() || run.stdout.toString('utf8').trim()).slice(0, 800);
  return withGitSetupHint(redactSecrets(text) || `exit code ${run.code}`);
}

// Until the Command Line Tools are installed, macOS's /usr/bin/git is a stub that fails every
// command with xcrun or xcode-select text, which does not say what to do.
const MISSING_XCODE_TOOLS = /xcrun: error|xcode-select: note|command line developer tools/i;
const XCODE_TOOLS_HINT = 'Install the Xcode Command Line Tools with `xcode-select --install`, then try again.';
export function withGitSetupHint(text: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'darwin' || !MISSING_XCODE_TOOLS.test(text) || text.includes(XCODE_TOOLS_HINT)) return text;
  return `${text}\n${XCODE_TOOLS_HINT}`;
}

async function gitOutput(cwd: string, args: string[], options?: GitRunOptions): Promise<string> {
  const run = await runGit(cwd, args, options);
  if (run.code !== 0) throw new Error(`git ${args[0]} failed: ${gitMessage(run)}`);
  return run.stdout.toString('utf8');
}

function normalizeRemoteUrl(url: string): string {
  return url.trim().replace(/\\/g, '/').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

// Unknown reasons fail closed as errors; only known non-credential reasons are overridable warnings.
function severityForReason(reason: string, file: string): ValidationSeverity {
  if (reason.startsWith('Git metadata, dependencies')) return 'warning';
  if (reason.startsWith('Database, log or credential') && /\.(db|sqlite3?|mdb|log)$/i.test(file)) return 'warning';
  return 'error';
}

// Publishing was refused or failed; `committed` counts files already committed locally before the failure.
export class PublishError extends Error {
  committed: number;
  issues?: FileValidationIssue[];
  constructor(message: string, readonly outcome: SyncOutcome, details: { committed?: number; issues?: FileValidationIssue[] } = {}) {
    super(message);
    this.name = 'PublishError';
    this.committed = details.committed ?? 0;
    this.issues = details.issues;
  }
}

// `merged` lists branches fully integrated (and pushed) before the failure at `stage`.
export class BranchIntegrationError extends Error {
  constructor(
    message: string,
    readonly branch: string,
    readonly stage: 'preflight' | 'merge' | 'validation' | 'push',
    readonly merged: string[],
    readonly conflicts: string[] = [],
  ) {
    super(message);
    this.name = 'BranchIntegrationError';
  }
}

function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  const chars = Array.from(quoted.slice(1, -1));
  const simple: Record<string, number> = { t: 9, n: 10, r: 13, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '\\') { bytes.push(...Buffer.from(chars[i], 'utf8')); continue; }
    const next = chars[++i] ?? '';
    if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(chars[i + 1] ?? '')) octal += chars[++i];
      bytes.push(parseInt(octal, 8));
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// With --no-renames both sides of the header name the same path, so its length is fixed by the header length.
function diffHeaderPath(header: string): string | null {
  if (header.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*") "/.exec(header);
    if (!match) return null;
    const name = unquoteGitPath(match[1]);
    return name.startsWith('a/') ? name.slice(2) : null;
  }
  const length = (header.length - 5) / 2;
  if (!Number.isInteger(length) || !header.startsWith('a/') || header.slice(2 + length, 5 + length) !== ' b/') return null;
  return header.slice(2, 2 + length);
}

function parseUnifiedDiff(text: string, scope: DiffScope): DiffInfo[] {
  const diffs: DiffInfo[] = [];
  for (const block of text.split(/^diff --git /m).slice(1)) {
    const lines = block.split('\n');
    const fileName = diffHeaderPath(lines[0]);
    if (fileName === null) continue;
    const info: DiffInfo = { fileName, changes: [], scope };
    let inHunk = false;
    let currentLine = 0;
    for (const line of lines.slice(1)) {
      if (line.startsWith('@@')) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
        if (hunk) currentLine = parseInt(hunk[1], 10);
        inHunk = true;
      } else if (!inHunk) {
        if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) info.binary = true;
      } else if (line[0] === '+' || line[0] === '-' || line[0] === ' ') {
        if (info.changes.length >= DIFF_PREVIEW_MAX_LINES) { info.truncated = true; break; }
        const type = line[0] === '+' ? 'add' : line[0] === '-' ? 'remove' : 'context';
        info.changes.push({ line: currentLine, type, content: line.slice(1) });
        if (type !== 'remove') currentLine++;
      }
    }
    diffs.push(info);
  }
  return diffs;
}

interface PendingEntry { path: string; index: string; worktree: string; untracked: boolean; conflicted: boolean; }
interface WorkingState {
  oid: string | null;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  entries: PendingEntry[];
}
interface UpstreamInfo { remote: string; ref: string; short: string; branchName: string; }
interface PushTarget { remote: string; remoteBranch: string; trackingRef: string; hasUpstream: boolean; }
interface PublishPlan { branch: string; target: PushTarget; state: WorkingState; selected: string[]; addOrigin: string | null; }
interface PublishReport { committed: number; commits: number; pushed: boolean; }
// oid is the tag ref's own object: the tag object for an annotated tag, else the tagged commit.
interface TagRef { name: string; oid: string; type: string; }
interface ScanResult { issues: FileValidationIssue[]; totalBytes: number; }

export class GitOperations {
  private git: SimpleGit;
  private repoPath: string;

  /**
   * Validates that a repository path is safe to use.
   * Prevents path traversal attacks and ensures the path is valid.
   */
  private static validateRepoPath(repoPath: string): void {
    // Check for path traversal attempts
    if (repoPath.includes('..')) {
      throw new Error('Invalid repository path: path traversal not allowed');
    }

    // Ensure path is absolute (starts with drive letter on Windows or / on Unix)
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(repoPath) || repoPath.startsWith('/');
    if (!isAbsolute) {
      throw new Error('Invalid repository path: must be an absolute path');
    }

    // Check path exists and is a directory
    if (!fs.existsSync(repoPath)) {
      throw new Error(`Repository path does not exist: ${repoPath}`);
    }

    const stats = fs.statSync(repoPath);
    if (!stats.isDirectory()) {
      throw new Error(`Repository path is not a directory: ${repoPath}`);
    }
  }

  /**
   * Validates a git ref name (branch, tag) against git naming rules.
   * Prevents command injection through malformed ref names.
   */
  static validateRefName(refName: string, type: 'branch' | 'tag'): void {
    if (typeof refName !== 'string') {
      throw new Error(`Invalid ${type} name: must be text`);
    }
    if (!refName || refName.trim().length === 0) {
      throw new Error(`Invalid ${type} name: cannot be empty`);
    }

    // Git ref naming rules - disallow dangerous patterns
    const invalidPatterns = [
      /^-/, // Cannot start with hyphen
      /\.\.$/, // Cannot end with ..
      /\.lock$/, // Cannot end with .lock
      /[\x00-\x1f\x7f]/, // No control characters
      /[~^:?*\[\]\\]/, // No special git characters
      /\s/, // No whitespace
      /^@$/, // Cannot be just @
      /\/\//, // No double slashes
      /^\//, // Cannot start with slash
      /\/$/, // Cannot end with slash
    ];

    for (const pattern of invalidPatterns) {
      if (pattern.test(refName)) {
        throw new Error(`Invalid ${type} name: contains forbidden characters or patterns`);
      }
    }

    // Max length check
    if (refName.length > 250) {
      throw new Error(`Invalid ${type} name: too long (max 250 characters)`);
    }
  }

  /**
   * Validates a commit hash format.
   */
  private static validateCommitHash(hash: string): void {
    if (!hash || hash.trim().length === 0) {
      throw new Error('Invalid commit hash: cannot be empty');
    }

    // Commit hash should be hex characters only, 7-40 chars
    if (!/^[a-fA-F0-9]{7,40}$/.test(hash)) {
      throw new Error('Invalid commit hash: must be 7-40 hexadecimal characters');
    }
  }

  constructor(repoPath: string) {
    GitOperations.validateRepoPath(repoPath);
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
  }

  // Legacy callers include analytics and other reads. Never create Git metadata here.
  async ensureGitRepo(): Promise<boolean> {
    await this.requireRepo();
    return false;
  }

  private run(args: string[], options?: GitRunOptions): Promise<GitRun> {
    return runGit(this.repoPath, args, options);
  }

  private output(args: string[], options?: GitRunOptions): Promise<string> {
    return gitOutput(this.repoPath, args, options);
  }

  // A project path must be a repository root: a plain folder inside another repository is not a repository.
  private async isRepoRoot(): Promise<boolean> {
    const run = await this.run(['rev-parse', '--is-inside-work-tree', '--show-cdup'], { readOnly: true });
    if (run.code !== 0) {
      if (/not a git repository/i.test(run.stderr)) return false;
      throw new Error(`Cannot read the Git repository: ${gitMessage(run)}`);
    }
    const [inside, cdup] = run.stdout.toString('utf8').split('\n');
    return inside.trim() === 'true' && (cdup ?? '').trim() === '';
  }

  private async requireRepo(): Promise<void> {
    if (!(await this.isRepoRoot())) throw new PublishError(`${this.repoPath} is not a Git repository.`, 'failed');
  }

  private async operationInProgress(): Promise<string | null> {
    const markers: Array<[string, string]> = [
      ['merge', 'MERGE_HEAD'], ['cherry-pick', 'CHERRY_PICK_HEAD'], ['revert', 'REVERT_HEAD'],
      ['rebase', 'rebase-merge'], ['rebase', 'rebase-apply'],
    ];
    const paths = (await this.output(['rev-parse', ...markers.flatMap(([, marker]) => ['--git-path', marker])], { readOnly: true })).split('\n');
    const hit = markers.findIndex((_, i) => paths[i] && fs.existsSync(path.resolve(this.repoPath, paths[i])));
    return hit === -1 ? null : markers[hit][0];
  }

  private async currentBranch(): Promise<string | null> {
    const run = await this.run(['symbolic-ref', '-q', '--short', 'HEAD'], { readOnly: true });
    return run.code === 0 ? run.stdout.toString('utf8').trim() || null : null;
  }

  private async remoteNames(): Promise<string[]> {
    return (await this.output(['remote'], { readOnly: true })).split('\n').map((name) => name.trim()).filter(Boolean);
  }

  private async headOid(): Promise<string | null> {
    const run = await this.run(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { readOnly: true });
    return run.code === 0 ? run.stdout.toString('utf8').trim() : null;
  }

  private async refExists(ref: string): Promise<boolean> {
    return (await this.run(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { readOnly: true })).code === 0;
  }

  private async countCommits(revs: string[]): Promise<number> {
    return Number((await this.output(['rev-list', '--count', ...revs, '--'], { readOnly: true })).trim());
  }

  private async upstreamOf(branch: string): Promise<UpstreamInfo | null> {
    const listed = await this.output(
      ['for-each-ref', '--format=%(upstream)%00%(upstream:remotename)%00%(upstream:short)', `refs/heads/${branch}`],
      { readOnly: true },
    );
    const [ref, remote, short] = listed.replace(/\n$/, '').split('\0');
    if (!ref || !remote || remote === '.') return null;
    const merge = (await this.run(['config', '--get', `branch.${branch}.merge`], { readOnly: true })).stdout.toString('utf8').trim();
    const branchName = merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : ref.replace(`refs/remotes/${remote}/`, '');
    return { remote, ref, short, branchName };
  }

  // Publishing goes to the branch's actual upstream; without one, to a same-named branch on origin.
  private async pushTarget(branch: string, originToAdd: string | null = null): Promise<PushTarget> {
    const upstream = await this.upstreamOf(branch);
    if (upstream) return { remote: upstream.remote, remoteBranch: upstream.branchName, trackingRef: upstream.ref, hasUpstream: true };
    if (!originToAdd && !(await this.remoteNames()).includes('origin')) {
      throw new PublishError("No 'origin' remote is configured. Provide the remote URL to publish to.", 'failed');
    }
    return { remote: 'origin', remoteBranch: branch, trackingRef: `refs/remotes/origin/${branch}`, hasUpstream: false };
  }

  private async workingState(): Promise<WorkingState> {
    const raw = await this.output(
      ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--no-renames'],
      { readOnly: true },
    );
    const state: WorkingState = { oid: null, branch: null, ahead: null, behind: null, entries: [] };
    const trackedByPath = new Map<string, PendingEntry>();
    for (const token of raw.split('\0')) {
      if (!token) continue;
      if (token.startsWith('# branch.oid ')) {
        const oid = token.slice('# branch.oid '.length);
        state.oid = oid === '(initial)' ? null : oid;
      } else if (token.startsWith('# branch.head ')) {
        const head = token.slice('# branch.head '.length);
        state.branch = head === '(detached)' ? null : head;
      } else if (token.startsWith('# branch.ab ')) {
        const counts = /^\+(\d+) -(\d+)$/.exec(token.slice('# branch.ab '.length));
        if (counts) { state.ahead = Number(counts[1]); state.behind = Number(counts[2]); }
      } else if (token.startsWith('1 ') || token.startsWith('u ')) {
        const fields = token.split(' ');
        const entry: PendingEntry = token[0] === 'u'
          ? { path: fields.slice(10).join(' '), index: 'U', worktree: 'U', untracked: false, conflicted: true }
          : { path: fields.slice(8).join(' '), index: fields[1][0], worktree: fields[1][1], untracked: false, conflicted: false };
        state.entries.push(entry);
        trackedByPath.set(entry.path, entry);
      } else if (token.startsWith('? ')) {
        const file = token.slice(2);
        // A path staged as deleted and recreated on disk is reported twice: keep one entry for it.
        const existing = trackedByPath.get(file);
        if (existing) existing.untracked = true;
        else state.entries.push({ path: file, index: '.', worktree: '.', untracked: true, conflicted: false });
      }
    }
    return state;
  }

  // Compares HEAD with the local copy of the target branch; `exists` false means the remote branch is not known.
  private async divergence(target: PushTarget): Promise<{ exists: boolean; ahead: number; behind: number }> {
    const head = await this.headOid();
    const exists = await this.refExists(target.trackingRef);
    if (!head) return { exists, ahead: 0, behind: exists ? await this.countCommits([target.trackingRef]) : 0 };
    if (!exists) return { exists, ahead: await this.countCommits(['HEAD', '--not', `--remotes=${target.remote}`]), behind: 0 };
    const counts = (await this.output(['rev-list', '--left-right', '--count', `HEAD...${target.trackingRef}`], { readOnly: true })).trim().split(/\s+/).map(Number);
    return { exists, ahead: counts[0], behind: counts[1] };
  }

  private static assertRemoteUrl(remoteUrl: string): void {
    if (typeof remoteUrl !== 'string' || !remoteUrl.trim() || remoteUrl.startsWith('-')
      || /[\x00-\x1f\x7f]/.test(remoteUrl) || /^[a-z0-9+.-]+::/i.test(remoteUrl)) {
      throw new PublishError('Invalid remote URL.', 'failed');
    }
  }

  // An existing origin is never rewritten to match the requested URL.
  private async originStatus(remoteUrl: string): Promise<'absent' | 'match'> {
    GitOperations.assertRemoteUrl(remoteUrl);
    const run = await this.run(['config', '--get-all', 'remote.origin.url'], { readOnly: true });
    if (run.code === 1) return 'absent';
    if (run.code !== 0) throw new Error(`Cannot read the remote configuration: ${gitMessage(run)}`);
    const urls = run.stdout.toString('utf8').split('\n').map((url) => url.trim()).filter(Boolean);
    if (urls.some((url) => normalizeRemoteUrl(url) === normalizeRemoteUrl(remoteUrl))) return 'match';
    throw new PublishError(
      `Remote 'origin' points to ${redactSecrets(urls[0] ?? '')}, not ${redactSecrets(remoteUrl)}. BitGit does not rewrite an existing remote; change it explicitly if that is intended.`,
      'failed',
    );
  }

  /**
   * Adds origin when it is absent. An existing origin with a different URL is an error, never rewritten.
   */
  async ensureRemote(remoteUrl: string): Promise<void> {
    if ((await this.originStatus(remoteUrl)) === 'absent') {
      console.error(`[Git] Adding origin remote: ${redactSecrets(remoteUrl)}`);
      await this.output(['remote', 'add', 'origin', remoteUrl]);
    }
  }

  private async listRemoteBranches(remote: string, exclude: Array<string | null | undefined>): Promise<string[]> {
    const prefix = `refs/remotes/${remote}/`;
    const names = (await this.output(['for-each-ref', '--format=%(refname)', prefix], { readOnly: true }))
      .split('\n').filter(Boolean).map((ref) => ref.slice(prefix.length));
    const head = await this.run(['symbolic-ref', '-q', `${prefix}HEAD`], { readOnly: true });
    const defaultBranch = head.code === 0 ? head.stdout.toString('utf8').trim().slice(prefix.length) : null;
    const hidden = new Set<string | null | undefined>(['HEAD', 'main', 'master', defaultBranch, ...exclude]);
    return names.filter((name) => !hidden.has(name));
  }

  /**
   * Reports local changes, the current branch, and its position against its actual upstream.
   * Never initializes Git, switches branches or edits remotes. A failed fetch is reported through
   * remoteError and leaves remoteCheckedAt null; ahead/behind then reflect the last known remote state.
   */
  async checkStatus(): Promise<StatusInfo> {
    const status: StatusInfo = {
      isGitRepo: false,
      hasRemote: false,
      currentBranch: null,
      upstream: null,
      remoteUrl: null,
      behindCommits: 0,
      remoteCheckedAt: null,
      remoteError: null,
      uncommittedFiles: 0,
      untrackedFiles: 0,
      modifiedFiles: [],
      unpushedCommits: 0,
      remoteBranches: [],
    };
    try {
      if (!(await this.isRepoRoot())) return status;
      status.isGitRepo = true;

      const branch = await this.currentBranch();
      const remotes = await this.remoteNames();
      const upstream = branch ? await this.upstreamOf(branch) : null;
      const remote = upstream?.remote ?? (remotes.includes('origin') ? 'origin' : remotes[0] ?? null);
      status.currentBranch = branch;
      status.hasRemote = remotes.length > 0;
      status.upstream = upstream?.short ?? null;

      if (remote) {
        const listed = await this.run(['remote', 'get-url', remote], { readOnly: true });
        if (listed.code === 0) {
          const value = listed.stdout.toString('utf8').trim();
          if (value) status.remoteUrl = value;
        }
        try {
          const fetched = await this.run(['fetch', '--prune', remote], { timeoutMs: STATUS_FETCH_TIMEOUT_MS });
          if (fetched.code === 0) status.remoteCheckedAt = new Date().toISOString();
          else status.remoteError = gitMessage(fetched);
        } catch (fetchError) {
          status.remoteError = errorText(fetchError);
        }
      }

      const state = await this.workingState();
      status.uncommittedFiles = state.entries.length;
      status.untrackedFiles = state.entries.filter((entry) => entry.untracked).length;
      status.modifiedFiles = state.entries.map((entry) => entry.path);

      if (upstream && state.ahead !== null && state.behind !== null) {
        status.unpushedCommits = state.ahead;
        status.behindCommits = state.behind;
      } else if (upstream && state.oid === null && await this.refExists(upstream.ref)) {
        status.behindCommits = await this.countCommits([upstream.ref]);
      } else {
        if (upstream && status.remoteCheckedAt && !(await this.refExists(upstream.ref))) {
          status.remoteError = `Upstream ${upstream.short} no longer exists on the remote`;
        }
        if (remote && state.oid) status.unpushedCommits = await this.countCommits(['HEAD', '--not', `--remotes=${remote}`]);
      }

      if (remote) status.remoteBranches = await this.listRemoteBranches(remote, [branch, upstream?.branchName]);

      console.error('[Git Status Check]', {
        path: this.repoPath,
        branch,
        upstream: status.upstream,
        changes: status.uncommittedFiles,
        ahead: status.unpushedCommits,
        behind: status.behindCommits,
        remoteChecked: status.remoteCheckedAt !== null,
      });
      return status;
    } catch (error) {
      throw new Error(`Failed to check status: ${errorText(error)}`);
    }
  }

  // ==================== PRE-SYNC VALIDATION ====================

  // GitHub file size limits; the hard 100 MiB limit comes from the shared policy (MAX_FILE_BYTES)
  private static readonly SIZE_LIMIT_WARNING = 50 * 1024 * 1024; // GitHub warns
  private static readonly SIZE_LIMIT_INFO = 10 * 1024 * 1024;    // flag for awareness

  // Warning-level patterns for files that typically shouldn't be in git. Credentials and oversize
  // files are handled by the shared policy (exclusionReason) and block instead.
  private static readonly PROBLEMATIC_PATTERNS: Array<{
    pattern: RegExp;
    reason: string;
    suggestion: string;
    gitignorePattern: string;
  }> = [
    // Databases
    { pattern: /\.sqlite3?$/i, reason: 'SQLite database file', suggestion: 'Database files should not be in git - they contain binary data that changes frequently', gitignorePattern: '*.sqlite3' },
    { pattern: /\.db$/i, reason: 'Database file', suggestion: 'Database files should not be in git', gitignorePattern: '*.db' },
    { pattern: /\.mdb$/i, reason: 'Access database file', suggestion: 'Database files should not be in git', gitignorePattern: '*.mdb' },

    // Logs
    { pattern: /\.log$/i, reason: 'Log file', suggestion: 'Log files are generated and should not be tracked', gitignorePattern: '*.log' },
    { pattern: /(?:^|\/)logs?\//i, reason: 'Log directory', suggestion: 'Log directories should be gitignored', gitignorePattern: 'logs/' },

    // Dependencies (these can be huge)
    { pattern: /(?:^|\/)node_modules\//i, reason: 'Node.js dependencies', suggestion: 'Run "npm install" to restore - never commit node_modules', gitignorePattern: 'node_modules/' },
    { pattern: /\.pnp\.cjs$/i, reason: 'Yarn PnP file', suggestion: 'Yarn PnP files can be large', gitignorePattern: '.pnp.cjs' },
    { pattern: /(?:^|\/)vendor\//i, reason: 'Vendor dependencies', suggestion: 'Vendor directories typically contain dependencies', gitignorePattern: 'vendor/' },
    { pattern: /(?:^|\/)\.venv\//i, reason: 'Python virtual environment', suggestion: 'Virtual environments should be gitignored', gitignorePattern: '.venv/' },
    { pattern: /(?:^|\/)venv\//i, reason: 'Python virtual environment', suggestion: 'Virtual environments should be gitignored', gitignorePattern: 'venv/' },
    { pattern: /(?:^|\/)__pycache__\//i, reason: 'Python bytecode cache', suggestion: 'Python cache should be gitignored', gitignorePattern: '__pycache__/' },

    // Build outputs
    { pattern: /(?:^|\/)dist\//i, reason: 'Build output directory', suggestion: 'Build outputs are generated and should be gitignored', gitignorePattern: 'dist/' },
    { pattern: /(?:^|\/)build\//i, reason: 'Build output directory', suggestion: 'Build outputs should be gitignored unless intentional', gitignorePattern: 'build/' },
    { pattern: /(?:^|\/)target\//i, reason: 'Rust/Maven build output', suggestion: 'Build outputs should be gitignored', gitignorePattern: 'target/' },
    { pattern: /(?:^|\/)\.next\//i, reason: 'Next.js build cache', suggestion: 'Next.js build cache should be gitignored', gitignorePattern: '.next/' },
    { pattern: /(?:^|\/)\.nuxt\//i, reason: 'Nuxt build cache', suggestion: 'Nuxt build cache should be gitignored', gitignorePattern: '.nuxt/' },

    // Large media files
    { pattern: /\.(mp4|mov|avi|mkv|webm)$/i, reason: 'Video file', suggestion: 'Large video files should use Git LFS or external storage', gitignorePattern: '*.mp4' },
    { pattern: /\.(zip|tar|gz|rar|7z)$/i, reason: 'Archive file', suggestion: 'Large archives should not be in git', gitignorePattern: '*.zip' },
    { pattern: /\.(iso|dmg|img)$/i, reason: 'Disk image', suggestion: 'Disk images should not be in git', gitignorePattern: '*.iso' },

    // IDE and OS files
    { pattern: /\.DS_Store$/i, reason: 'macOS metadata', suggestion: 'OS-specific files should be gitignored', gitignorePattern: '.DS_Store' },
    { pattern: /Thumbs\.db$/i, reason: 'Windows thumbnail cache', suggestion: 'OS-specific files should be gitignored', gitignorePattern: 'Thumbs.db' },
    { pattern: /(?:^|\/)\.idea\//i, reason: 'JetBrains IDE config', suggestion: 'IDE configs are often user-specific', gitignorePattern: '.idea/' },

    // Temporary files
    { pattern: /\.tmp$/i, reason: 'Temporary file', suggestion: 'Temporary files should not be tracked', gitignorePattern: '*.tmp' },
    { pattern: /\.temp$/i, reason: 'Temporary file', suggestion: 'Temporary files should not be tracked', gitignorePattern: '*.temp' },
    { pattern: /\.swp$/i, reason: 'Vim swap file', suggestion: 'Editor swap files should be gitignored', gitignorePattern: '*.swp' },
    { pattern: /~$/i, reason: 'Backup file', suggestion: 'Backup files should be gitignored', gitignorePattern: '*~' },
  ];

  // Issues never carry file content; `commit` marks content that is already in an unpushed commit.
  private static screenFile(filePath: string, size: number, load: (() => Buffer) | null, commit?: string): FileValidationIssue[] {
    const sizeMB = size / (1024 * 1024);
    const where = commit ? ` (in unpushed commit ${commit.slice(0, 7)})` : '';
    const committedAdvice = 'It is already in a local commit; .gitignore cannot remove it. Rewrite that commit before publishing.';
    const found = (severity: ValidationSeverity, reason: string, suggestion?: string, gitignorePattern?: string): FileValidationIssue => ({
      filePath,
      severity,
      reason: reason + where,
      sizeBytes: size,
      sizeMB,
      suggestion: commit ? committedAdvice : suggestion,
      ...(commit ? {} : { gitignorePattern }),
    });

    let reason = exclusionReason(filePath, size);
    if (!reason && load && size <= MAX_FILE_BYTES) reason = exclusionReason(filePath, size, load());
    if (reason) {
      const severity = severityForReason(reason, filePath);
      if (reason.startsWith('File exceeds')) reason = `File exceeds GitHub's 100MB limit (${sizeMB.toFixed(1)}MB)`;
      return [found(
        severity,
        reason,
        severity === 'error' ? 'Publishing is blocked. Remove this content, or add the file to .gitignore.' : 'Review whether this file belongs in the repository.',
        filePath,
      )];
    }

    const issues: FileValidationIssue[] = [];
    if (size >= GitOperations.SIZE_LIMIT_WARNING) {
      issues.push(found('warning', `Large file (${sizeMB.toFixed(1)}MB) - GitHub warns above 50MB`, 'Consider using Git LFS for files this large.'));
    } else if (size >= GitOperations.SIZE_LIMIT_INFO) {
      issues.push(found('info', `Notable file size (${sizeMB.toFixed(1)}MB)`));
    }
    const pattern = GitOperations.PROBLEMATIC_PATTERNS.find((candidate) => candidate.pattern.test(filePath));
    if (pattern) issues.push(found('warning', pattern.reason, pattern.suggestion, pattern.gitignorePattern));
    return issues;
  }

  private static sortIssues(issues: FileValidationIssue[]): FileValidationIssue[] {
    const order = { error: 0, warning: 1, info: 2 };
    return issues.sort((a, b) => order[a.severity] - order[b.severity]);
  }

  // Errors always block; warnings block unless the caller passed allowWarnings.
  private static enforce(issues: FileValidationIssue[], allowWarnings: boolean, committed = 0, subject = 'Publish'): void {
    const errors = issues.filter((issue) => issue.severity === 'error');
    const warnings = issues.filter((issue) => issue.severity === 'warning');
    if (errors.length === 0 && (warnings.length === 0 || allowWarnings)) return;
    const shown = [...errors, ...(allowWarnings ? [] : warnings)];
    const list = shown.slice(0, 8).map((issue) => `${issue.filePath}: ${issue.reason}`).join('; ');
    const more = shown.length > 8 ? ` (+${shown.length - 8} more)` : '';
    const advice = errors.length > 0
      ? 'Remove the blocked content; it cannot be overridden.'
      : 'Review the warnings and retry with allowWarnings to publish anyway.';
    throw new PublishError(
      `${subject} blocked by validation (${errors.length} error(s), ${warnings.length} warning(s)): ${list}${more}. ${advice}`,
      'blocked',
      { issues, committed },
    );
  }

  // Options arrive from IPC: only a real boolean true may allow warnings; anything else malformed is refused.
  private static allowWarnings(options: PublishOptions | null | undefined): boolean {
    if (options === undefined || options === null) return false;
    if (typeof options !== 'object' || Array.isArray(options)) throw new PublishError('Publish options must be an object.', 'failed');
    const allow = options.allowWarnings;
    if (allow !== undefined && allow !== null && typeof allow !== 'boolean') throw new PublishError('allowWarnings must be true or false.', 'failed');
    return allow === true;
  }

  private static normalizeSelection(options?: PublishOptions): string[] {
    const files = options?.selectedFiles;
    if (files === undefined || files === null) return [];
    if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) {
      throw new PublishError('selectedFiles must be an array of repository-relative paths.', 'failed');
    }
    return files;
  }

  // Selection is limited to paths git itself reports as pending, so a name is never trusted as a path.
  private static validateSelection(selection: string[], pending: Map<string, PendingEntry>): string[] {
    const selected = new Set<string>();
    for (const requested of selection) {
      if (requested.length === 0 || /[\x00-\x1f\x7f]/.test(requested)) {
        throw new PublishError('Selected file paths cannot be empty or contain control characters.', 'failed');
      }
      if (requested.startsWith('-')) throw new PublishError(`Selected path '${requested}' looks like a command option and was rejected.`, 'failed');
      if (/^([a-zA-Z]:|[\\/])/.test(requested)) throw new PublishError(`Selected path '${requested}' must be relative to the repository.`, 'failed');
      if (requested.split(/[\\/]/).includes('..')) throw new PublishError(`Selected path '${requested}' must stay inside the repository.`, 'failed');
      const candidate = pending.has(requested) ? requested : requested.replace(/\\/g, '/');
      const entry = pending.get(candidate);
      if (!entry) throw new PublishError(`'${requested}' is not a pending change in this repository.`, 'failed');
      if (candidate.endsWith('/')) throw new PublishError(`'${requested}' is a directory or nested repository; select its files instead.`, 'failed');
      if (entry.conflicted) throw new PublishError(`'${requested}' has unresolved conflicts.`, 'conflicted');
      selected.add(candidate);
    }
    return [...selected];
  }

  private async blobSizes(oids: string[]): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    if (oids.length === 0) return sizes;
    const run = await this.run(['cat-file', '--batch-check'], { readOnly: true, input: `${oids.join('\n')}\n` });
    if (run.code !== 0) throw new PublishError(`Cannot inspect outgoing objects: ${gitMessage(run)}`, 'blocked');
    for (const line of run.stdout.toString('utf8').split('\n')) {
      if (!line) continue;
      const [oid, type, size] = line.split(' ');
      if (type === 'blob') sizes.set(oid, Number(size));
    }
    if (sizes.size !== oids.length) {
      throw new PublishError('Cannot inspect every outgoing object; the object database is incomplete.', 'blocked');
    }
    return sizes;
  }

  private async readObjects(oids: string[], expected: 'blob' | 'tag' = 'blob'): Promise<Map<string, Buffer>> {
    const run = await this.run(['cat-file', '--batch'], { readOnly: true, input: `${oids.join('\n')}\n` });
    if (run.code !== 0) throw new PublishError(`Cannot read outgoing objects: ${gitMessage(run)}`, 'blocked');
    const objects = new Map<string, Buffer>();
    const data = run.stdout;
    let offset = 0;
    while (offset < data.length) {
      const eol = data.indexOf(0x0a, offset);
      if (eol < 0) break;
      const [oid, type, size] = data.toString('utf8', offset, eol).split(' ');
      if (type !== expected) throw new PublishError('Cannot read every outgoing object.', 'blocked');
      const start = eol + 1;
      objects.set(oid, data.subarray(start, start + Number(size)));
      offset = start + Number(size) + 1;
    }
    return objects;
  }

  // Inspects every blob added by commits reachable from `tips` but not from `not` (all of them: no
  // history cap), path by path. Tips go through stdin so a long tag list cannot overflow the command line.
  private async scanRange(tips: string[], not: string[]): Promise<ScanResult> {
    const log = await this.run(
      ['log', '--no-renames', '-c', '--root', '--raw', '-z', '--no-abbrev', '--format=%H%x01', '--stdin', ...(not.length > 0 ? ['--not', ...not] : []), '--'],
      { readOnly: true, input: `${tips.join('\n')}\n` },
    );
    if (log.code !== 0) throw new PublishError(`Cannot inspect outgoing commits: ${gitMessage(log)}`, 'blocked');

    const added: Array<{ commit: string; file: string; oid: string }> = [];
    const tokens = log.stdout.toString('utf8').split('\0');
    let commit = '';
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i].replace(/^\n+/, '');
      if (token.startsWith(':')) {
        // Combined diff for merges (one colon per parent): only blobs that differ from every parent are new.
        const parents = /^:+/.exec(token)![0].length;
        const fields = token.slice(parents).split(' ');
        const newMode = fields[parents];
        const newOid = fields[2 * parents + 1];
        const file = tokens[++i];
        if (newMode === '000000' || newMode === '160000') continue;
        added.push({ commit, file, oid: newOid });
      } else if (/^[0-9a-f]{40,64}\x01$/.test(token)) {
        commit = token.slice(0, -1);
      }
    }

    const byOid = new Map<string, typeof added>();
    for (const blob of added) {
      const group = byOid.get(blob.oid);
      if (group) group.push(blob); else byOid.set(blob.oid, [blob]);
    }
    const sizes = await this.blobSizes([...byOid.keys()]);
    const issues: FileValidationIssue[] = [];
    let totalBytes = 0;
    const scannable: string[] = [];
    for (const [oid, group] of byOid) {
      const size = sizes.get(oid)!;
      totalBytes += size;
      if (size <= MAX_FILE_BYTES && group.some((blob) => exclusionReason(blob.file, size) === null)) scannable.push(oid);
      else for (const blob of group) issues.push(...GitOperations.screenFile(blob.file, size, null, blob.commit));
    }

    let chunk: string[] = [];
    let chunkBytes = 0;
    const flush = async () => {
      if (chunk.length === 0) return;
      const contents = await this.readObjects(chunk);
      for (const oid of chunk) {
        for (const blob of byOid.get(oid)!) {
          issues.push(...GitOperations.screenFile(blob.file, sizes.get(oid)!, () => contents.get(oid)!, blob.commit));
        }
      }
      chunk = [];
      chunkBytes = 0;
    };
    for (const oid of scannable) {
      const size = sizes.get(oid)!;
      if (chunk.length > 0 && chunkBytes + size > BLOB_CHUNK_BYTES) await flush();
      chunk.push(oid);
      chunkBytes += size;
    }
    await flush();
    return { issues, totalBytes };
  }

  // Blobs in commits reachable from HEAD that no remote-tracking ref of `remote` already has.
  private async scanOutgoing(remote: string): Promise<ScanResult> {
    if (!(await this.headOid())) return { issues: [], totalBytes: 0 };
    return this.scanRange(['HEAD'], [`--remotes=${remote}`]);
  }

  // Selected pending files (working contents, as they would be committed) plus what would newly reach `remote`.
  private async collectIssues(selected: string[], remote: string | null): Promise<ScanResult> {
    const issues: FileValidationIssue[] = [];
    let totalBytes = 0;
    for (const file of selected) {
      const fullPath = path.join(this.repoPath, file);
      let stats: fs.Stats;
      try {
        stats = fs.lstatSync(fullPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // a deletion publishes no content
        throw error;
      }
      if (stats.isDirectory()) continue;
      totalBytes += stats.size;
      issues.push(...GitOperations.screenFile(file, stats.size, stats.isSymbolicLink() ? null : () => fs.readFileSync(fullPath)));
    }
    if (remote) {
      const outgoing = await this.scanOutgoing(remote);
      issues.push(...outgoing.issues);
      totalBytes += outgoing.totalBytes;
    }
    return { issues: GitOperations.sortIssues(issues), totalBytes };
  }

  /**
   * Previews what publishing with `options` would check: the selected pending files' working contents
   * and the blobs in unpushed commits. Without selectedFiles only unpushed commits are inspected.
   * canProceed is false when a blocking error exists; warnings only block publishing without allowWarnings.
   */
  async validateBeforeSync(options?: PublishOptions): Promise<PreSyncValidation> {
    GitOperations.allowWarnings(options); // reject malformed options even though warnings are only reported here
    await this.requireRepo();
    try {
      const state = await this.workingState();
      const selected = GitOperations.validateSelection(
        GitOperations.normalizeSelection(options),
        new Map(state.entries.map((entry) => [entry.path, entry])),
      );
      const upstream = state.branch ? await this.upstreamOf(state.branch) : null;
      const remotes = await this.remoteNames();
      const remote = upstream?.remote ?? (remotes.includes('origin') || remotes.length === 0 ? 'origin' : remotes[0]);

      const { issues, totalBytes } = await this.collectIssues(selected, remote);
      console.error(`[Validation] ${selected.length} selected file(s): ${issues.length} issues, ${(totalBytes / (1024 * 1024)).toFixed(1)}MB inspected`);
      return {
        canProceed: !issues.some((issue) => issue.severity === 'error'),
        hasWarnings: issues.some((issue) => issue.severity === 'warning'),
        totalStagedSize: totalBytes,
        totalStagedSizeMB: totalBytes / (1024 * 1024),
        issues,
        suggestedGitignore: [...new Set(issues.filter((issue) => issue.severity !== 'info' && issue.gitignorePattern).map((issue) => issue.gitignorePattern!))],
      };
    } catch (error) {
      if (error instanceof PublishError) throw error;
      throw new Error(`Failed to validate files: ${errorText(error)}`);
    }
  }

  // ==================== PUBLISHING ====================

  // Checks everything that can be checked before any mutation; only origin is added later, at push time.
  private async preparePublish(remoteUrl: string | undefined, options: PublishOptions | undefined): Promise<PublishPlan> {
    const selection = GitOperations.normalizeSelection(options);
    await this.requireRepo();
    const operation = await this.operationInProgress();
    if (operation) throw new PublishError(`A ${operation} is in progress. Finish or abort it before publishing.`, 'conflicted');
    const branch = await this.currentBranch();
    if (!branch) throw new PublishError('HEAD is detached. Switch to a branch before publishing.', 'failed');

    const state = await this.workingState();
    if (state.entries.some((entry) => entry.conflicted)) {
      throw new PublishError('Unresolved merge conflicts exist. Resolve them before publishing.', 'conflicted');
    }
    if (selection.length === 0 && state.entries.length > 0) {
      throw new PublishError(
        `${state.entries.length} uncommitted change(s) exist and no files were selected. Choose the files to commit; BitGit does not stage everything automatically.`,
        'needs-selection',
      );
    }
    const selected = GitOperations.validateSelection(selection, new Map(state.entries.map((entry) => [entry.path, entry])));
    const addOrigin = remoteUrl && (await this.originStatus(remoteUrl)) === 'absent' ? remoteUrl : null;
    return { branch, target: await this.pushTarget(branch, addOrigin), state, selected, addOrigin };
  }

  private async commitSelected(plan: PublishPlan, message: string, description: string | undefined): Promise<void> {
    const untracked = plan.selected.filter((file) => plan.state.entries.some((entry) => entry.path === file && entry.untracked));
    try {
      // --only commits the working contents of exactly these paths and leaves other staged entries alone;
      // untracked paths must be known to git first, so they get an intent-to-add placeholder.
      if (untracked.length > 0) await this.output(['add', '-N', '--', ...untracked]);
      const args = ['commit', '-m', message];
      if (description) args.push('-m', description);
      await this.output([...args, '--only', '--', ...plan.selected]);
    } catch (error) {
      // Best effort by design: drop the placeholders so a failed commit leaves the index as it was.
      if (untracked.length > 0) await this.run(['reset', '-q', '--', ...untracked]).catch(() => undefined);
      throw new PublishError(errorText(error), 'failed');
    }
  }

  private async pushCurrent(branch: string, target: PushTarget): Promise<void> {
    const label = `${target.remote}/${target.remoteBranch}`;
    const args = ['push', '--porcelain', ...(target.hasUpstream ? [] : ['-u']), target.remote, `refs/heads/${branch}:refs/heads/${target.remoteBranch}`];
    let run: GitRun;
    try {
      run = await this.run(args, { timeoutMs: NETWORK_TIMEOUT_MS });
    } catch (error) {
      throw new PublishError(`Push to ${label} failed: ${errorText(error)}`, 'push-failed');
    }
    if (run.code !== 0) {
      const text = `${run.stderr}\n${run.stdout.toString('utf8')}`;
      throw new PublishError(
        /non-fast-forward|fetch first|\[rejected\]/i.test(text)
          ? `Push to ${label} was rejected: the remote has commits ${branch} lacks. BitGit never force-pushes; update ${branch} first.`
          : `Push to ${label} failed: ${gitMessage(run)}`,
        'push-failed',
      );
    }
    const tracked = await this.run(['rev-parse', '--verify', '-q', `${target.trackingRef}^{commit}`], { readOnly: true });
    if (tracked.code === 0 && tracked.stdout.toString('utf8').trim() !== (await this.headOid())) {
      throw new PublishError(`Push to ${label} reported success but ${target.trackingRef} does not match the pushed commit.`, 'push-failed');
    }
  }

  // Validates, commits the selected files (if any) and pushes. Existing unpushed commits are inspected
  // too; nothing is committed or pushed once validation fails.
  private async executePublish(
    plan: PublishPlan,
    message: string | undefined,
    description: string | undefined,
    allowWarnings: boolean,
  ): Promise<PublishReport> {
    const { branch, target, selected } = plan;
    const label = `${target.remote}/${target.remoteBranch}`;
    const head = await this.headOid();
    const before = await this.divergence(target);

    if (selected.length === 0 && (head === null || (before.ahead === 0 && before.exists))) {
      return { committed: 0, commits: 0, pushed: false };
    }
    if (before.behind > 0) {
      throw new PublishError(
        before.ahead > 0
          ? `${branch} has diverged from ${label} (${before.ahead} local, ${before.behind} remote commit(s)). Nothing was pushed; BitGit never force-pushes. Integrate the remote changes first.`
          : `${label} has ${before.behind} commit(s) that ${branch} lacks. Update ${branch} before committing new work.`,
        before.ahead > 0 ? 'diverged' : 'dirty-behind',
      );
    }

    GitOperations.enforce((await this.collectIssues(selected, target.remote)).issues, allowWarnings);

    let committed = 0;
    if (selected.length > 0) {
      await this.commitSelected(plan, message || `Auto-sync: ${new Date().toISOString()}`, description);
      committed = selected.length;
      try {
        // The stored blobs can differ from the inspected working files (filters, hooks), so inspect the commit itself.
        const created = await this.scanRange(['HEAD'], head ? [head] : []);
        GitOperations.enforce(GitOperations.sortIssues(created.issues), allowWarnings, committed);
      } catch (error) {
        if (error instanceof PublishError) {
          error.committed = committed;
          error.message += ' The new commit exists locally and was not pushed.';
        }
        throw error;
      }
    }

    if (plan.addOrigin) {
      await this.output(['remote', 'add', 'origin', plan.addOrigin]);
      plan.addOrigin = null;
    }
    const outgoing = (await this.divergence(target)).ahead;
    try {
      await this.pushCurrent(branch, target);
    } catch (error) {
      if (error instanceof PublishError) error.committed = committed;
      throw error;
    }
    return { committed, commits: outgoing, pushed: true };
  }

  /**
   * Commits only options.selectedFiles (whole files, working contents; other staged entries stay
   * staged) and pushes the current branch to its upstream. Without a selection nothing is staged:
   * unpushed commits are pushed, and pending changes make the call fail with a choose-files message.
   * Secrets and blobs over 100 MiB always block; warnings block unless options.allowWarnings is true.
   * `committed` is the number of files committed; `pushed` is true only when a push was performed.
   */
  async pushLocal(
    remoteUrl?: string,
    commitMessage?: string,
    commitDescription?: string,
    options?: PublishOptions
  ): Promise<{ committed: number; pushed: boolean }> {
    try {
      const allowWarnings = GitOperations.allowWarnings(options);
      const plan = await this.preparePublish(remoteUrl, options);
      const report = await this.executePublish(plan, commitMessage, commitDescription, allowWarnings);
      return { committed: report.committed, pushed: report.pushed };
    } catch (error) {
      if (error instanceof PublishError) throw error;
      throw new Error(`Failed to push local changes: ${errorText(error)}`);
    }
  }

  /**
   * Pushes commits that already exist (used by pushToRemote). Validation covers every blob the push
   * would add to the remote. Returns the number of commits that were outgoing.
   */
  async pushExistingCommits(remote: string, branch: string, options?: PublishOptions): Promise<number> {
    GitOperations.validateRefName(branch, 'branch');
    const allowWarnings = GitOperations.allowWarnings(options);
    await this.requireRepo();
    if (typeof remote !== 'string' || !/^[A-Za-z0-9][\w.-]*$/.test(remote) || !(await this.remoteNames()).includes(remote)) {
      throw new PublishError(`Remote '${remote}' is not configured.`, 'failed');
    }
    const current = await this.currentBranch();
    if (current !== branch) throw new PublishError(`Cannot publish ${branch}: ${current ?? 'a detached HEAD'} is checked out.`, 'failed');
    const target: PushTarget = { remote, remoteBranch: branch, trackingRef: `refs/remotes/${remote}/${branch}`, hasUpstream: false };
    const position = await this.divergence(target);
    if (position.behind > 0) {
      throw new PublishError(`${remote}/${branch} has ${position.behind} commit(s) that ${branch} lacks. BitGit never force-pushes; update ${branch} first.`, 'diverged');
    }
    GitOperations.enforce(GitOperations.sortIssues((await this.scanOutgoing(remote)).issues), allowWarnings);
    await this.pushCurrent(branch, target);
    return position.ahead;
  }

  /**
   * Explicit integration of the named remote branches into the current branch, one at a time with
   * --no-ff, pushing after each. Any failure throws BranchIntegrationError naming the branch and stage
   * (merge conflicts abort the merge and leave the branch unchanged). Source branches are never
   * deleted, locally or on the remote: a collaborator or agent may push to them after the merge, and
   * a delete could only be made safe with a force-style lease.
   */
  private async integrateBranches(
    branches: string[],
    remoteUrl: string | undefined,
    options: PublishOptions | undefined,
    verb: 'merge' | 'pull',
  ): Promise<string[]> {
    const allowWarnings = GitOperations.allowWarnings(options);
    const merged: string[] = [];
    if (!Array.isArray(branches) || branches.length === 0) return merged;
    for (const name of branches) GitOperations.validateRefName(name, 'branch');
    const fail = (branch: string, stage: BranchIntegrationError['stage'], message: string, conflicts: string[] = []) =>
      new BranchIntegrationError(message, branch, stage, [...merged], conflicts);

    await this.requireRepo();
    if (remoteUrl) await this.ensureRemote(remoteUrl);
    const operation = await this.operationInProgress();
    if (operation) throw fail('', 'preflight', `A ${operation} is in progress. Finish or abort it first.`);
    const current = await this.currentBranch();
    if (!current) throw fail('', 'preflight', 'HEAD is detached. Switch to a branch before integrating branches.');
    const target = await this.pushTarget(current);
    const label = `${target.remote}/${target.remoteBranch}`;
    if ((await this.workingState()).entries.some((entry) => !entry.untracked)) {
      throw fail('', 'preflight', `Uncommitted changes to tracked files exist. Commit or stash them before ${verb}ing branches.`);
    }
    try {
      const fetched = await this.run(['fetch', '--prune', target.remote], { timeoutMs: FETCH_TIMEOUT_MS });
      if (fetched.code !== 0) throw new Error(gitMessage(fetched));
    } catch (error) {
      throw fail('', 'preflight', `Could not fetch ${target.remote}: ${errorText(error)}`);
    }
    const position = await this.divergence(target);
    if (position.behind > 0) {
      throw fail('', 'preflight', `${current} is behind ${label} by ${position.behind} commit(s); update it before integrating branches.`);
    }

    const assertPublishable = async (branch: string, note: string): Promise<void> => {
      try {
        GitOperations.enforce(GitOperations.sortIssues((await this.scanOutgoing(target.remote)).issues), allowWarnings);
      } catch (error) {
        throw fail(branch, 'validation', errorText(error) + note);
      }
    };
    await assertPublishable('', '');

    for (const branch of branches) {
      let stage: BranchIntegrationError['stage'] = 'preflight';
      try {
        if (branch === current) throw fail(branch, 'preflight', `Cannot ${verb} ${branch} into itself.`);
        const remoteRef = `refs/remotes/${target.remote}/${branch}`;
        if (!(await this.refExists(remoteRef))) throw fail(branch, 'preflight', `Branch '${branch}' does not exist on ${target.remote}.`);

        stage = 'merge';
        const merge = await this.run(['merge', '--no-ff', '-m', verb === 'merge' ? `Merge branch '${branch}'` : `Pull updates from branch '${branch}'`, remoteRef]);
        if (merge.code !== 0) {
          const conflicts = (await this.run(['diff', '--name-only', '--diff-filter=U', '-z'], { readOnly: true })).stdout.toString('utf8').split('\0').filter(Boolean);
          await this.run(['merge', '--abort']); // when git refused before starting there is nothing to abort
          throw fail(
            branch,
            'merge',
            conflicts.length > 0
              ? `Merging '${branch}' conflicts in ${conflicts.length} file(s): ${conflicts.slice(0, 8).join(', ')}. The merge was aborted; ${current} is unchanged.`
              : `Merging '${branch}' failed: ${gitMessage(merge)}`,
            conflicts,
          );
        }

        stage = 'validation';
        await assertPublishable(branch, ` The merge of '${branch}' is committed locally but was not pushed.`);

        stage = 'push';
        try {
          await this.pushCurrent(current, target);
        } catch (error) {
          throw fail(branch, 'push', `${errorText(error)} The merge of '${branch}' is committed locally but was not pushed.`);
        }
        merged.push(branch);
      } catch (error) {
        if (error instanceof BranchIntegrationError) throw error;
        throw fail(branch, stage, errorText(error));
      }
    }
    return merged;
  }

  async mergeBranches(branches: string[], remoteUrl?: string, options?: PublishOptions): Promise<string[]> {
    return this.integrateBranches(branches, remoteUrl, options, 'merge');
  }

  /**
   * Same integration as mergeBranches with a "Pull updates" merge message.
   */
  async pullBranches(branches: string[], remoteUrl?: string, options?: PublishOptions): Promise<string[]> {
    return this.integrateBranches(branches, remoteUrl, options, 'pull');
  }

  /**
   * Syncs the current branch with its actual upstream only: fast-forwards when it is behind and clean,
   * otherwise publishes like pushLocal. Other branches are never merged or deleted; divergence,
   * dirty-behind, missing selection, validation blocks and fetch/push failures return success: false
   * with an explicit outcome and errors. `committed` is files committed, `pushed` commits transferred.
   */
  async fullSync(
    remoteUrl?: string,
    commitMessage?: string,
    commitDescription?: string,
    options?: PublishOptions
  ): Promise<SyncResult> {
    const result: SyncResult = { success: false, message: '', committed: 0, pushed: 0, pulled: 0, merged: [], errors: [], outcome: 'failed' };
    const stop = (outcome: SyncOutcome, message: string): SyncResult => {
      result.outcome = outcome;
      result.message = message;
      result.errors!.push(message);
      return result;
    };

    try {
      const allowWarnings = GitOperations.allowWarnings(options);
      const plan = await this.preparePublish(remoteUrl, options);
      const { branch, target } = plan;
      const label = `${target.remote}/${target.remoteBranch}`;

      if (plan.addOrigin) {
        // A remote that is not configured yet has nothing to fetch. executePublish adds origin only after
        // validation passes and just before the push, so a blocked sync leaves the remote list untouched.
        if (plan.selected.length === 0 && !(await this.headOid())) {
          return stop('failed', 'Nothing to publish: the repository has no commits yet. Select files to create the first commit.');
        }
      } else {
        let fetched: GitRun;
        try {
          fetched = await this.run(['fetch', '--prune', target.remote], { timeoutMs: FETCH_TIMEOUT_MS });
        } catch (error) {
          return stop('fetch-failed', `Could not fetch ${target.remote}: ${errorText(error)}`);
        }
        if (fetched.code !== 0) return stop('fetch-failed', `Could not fetch ${target.remote}: ${gitMessage(fetched)}`);

        const position = await this.divergence(target);
        if (position.behind > 0 && position.ahead > 0) {
          return stop('diverged', `${branch} has diverged from ${label} (${position.ahead} local, ${position.behind} remote commit(s)). Nothing was changed; integrate the remote changes explicitly, then sync again.`);
        }
        if (position.behind > 0 && plan.state.entries.length > 0) {
          return stop('dirty-behind', `${label} has ${position.behind} new commit(s) and ${branch} has uncommitted changes. Nothing was changed; commit or stash the changes, update ${branch}, then sync again.`);
        }
        if (position.behind > 0) {
          const forwarded = await this.run(['merge', '--ff-only', target.trackingRef]);
          if (forwarded.code !== 0) return stop('failed', `Could not fast-forward ${branch} to ${label}: ${gitMessage(forwarded)}`);
          result.success = true;
          result.outcome = 'fast-forwarded';
          result.pulled = position.behind;
          result.message = `Fast-forwarded ${branch} by ${position.behind} commit(s) from ${label}`;
          return result;
        }
      }

      const report = await this.executePublish(plan, commitMessage, commitDescription, allowWarnings);
      result.success = true;
      result.committed = report.committed;
      result.pushed = report.commits;
      if (!report.pushed) {
        result.outcome = 'up-to-date';
        result.message = `${branch} is up to date with ${label}`;
      } else {
        result.outcome = 'published';
        result.message = `${report.committed > 0 ? `Committed ${report.committed} file(s) and ` : ''}${report.commits > 0 ? `pushed ${report.commits} commit(s) to` : 'published'} ${label}`;
        result.message = result.message[0].toUpperCase() + result.message.slice(1);
      }
      return result;
    } catch (error) {
      if (error instanceof PublishError) {
        result.committed = error.committed;
        result.issues = error.issues;
        return stop(error.outcome, error.message);
      }
      return stop('failed', `Full sync failed: ${errorText(error)}`);
    }
  }

  // ==================== ADVANCED GIT FEATURES ====================

  /**
   * Get all branches (local and remote)
   */
  async getBranches(): Promise<BranchInfo[]> {
    await this.ensureGitRepo();
    try {
      const branchSummary = await this.git.branch(['-a', '-v']);
      const branches: BranchInfo[] = [];

      for (const [name, info] of Object.entries(branchSummary.branches)) {
        const isRemote = name.startsWith('remotes/');
        const cleanName = isRemote ? name.replace('remotes/origin/', '') : name;

        // Skip HEAD references
        if (cleanName.includes('HEAD')) continue;

        branches.push({
          name: cleanName,
          current: info.current,
          commit: info.commit,
          label: info.label,
          isRemote,
        });
      }

      return branches;
    } catch (error) {
      throw new Error(`Failed to get branches: ${error}`);
    }
  }

  /**
   * Create a new branch
   */
  async createBranch(branchName: string, checkout: boolean = false): Promise<void> {
    GitOperations.validateRefName(branchName, 'branch');
    await this.ensureGitRepo();
    try {
      if (checkout) {
        await this.git.checkoutLocalBranch(branchName);
      } else {
        await this.git.branch([branchName]);
      }
    } catch (error) {
      throw new Error(`Failed to create branch: ${error}`);
    }
  }

  /**
   * Switch to a different branch
   */
  async switchBranch(branchName: string): Promise<void> {
    GitOperations.validateRefName(branchName, 'branch');
    await this.ensureGitRepo();
    try {
      // The trailing `--` keeps the name from being read as a pathspec.
      await this.git.raw(['checkout', branchName, '--']);
    } catch (error) {
      throw new Error(`Failed to switch branch: ${error}`);
    }
  }

  /**
   * Delete a branch
   */
  async deleteBranch(branchName: string, force: boolean = false): Promise<void> {
    GitOperations.validateRefName(branchName, 'branch');
    await this.ensureGitRepo();
    try {
      const flag = force === true ? '-D' : '-d';
      await this.git.branch([flag, '--', branchName]);
    } catch (error) {
      throw new Error(`Failed to delete branch: ${error}`);
    }
  }

  /**
   * Get commit history with limit
   */
  async getCommitHistory(limit: number = 50): Promise<CommitInfo[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Commit history limit must be 1-1000');
    await this.ensureGitRepo();
    try {
      const log: LogResult = await this.git.log({ maxCount: limit });

      return log.all.map(commit => ({
        hash: commit.hash,
        author: commit.author_name,
        email: commit.author_email,
        date: commit.date,
        message: commit.message,
        body: commit.body,
        refs: commit.refs,
      }));
    } catch (error) {
      throw new Error(`Failed to get commit history: ${error}`);
    }
  }

  /**
   * Pending files with their staged/unstaged/untracked state, for building a file selection.
   * A partially staged file reports both `staged` and `unstaged`.
   */
  async getFileChanges(): Promise<FileChangeInfo[]> {
    await this.requireRepo();
    const kinds: Record<string, FileChangeKind> = {
      M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', U: 'conflicted',
    };
    return (await this.workingState()).entries.map((entry) => ({
      path: entry.path,
      staged: kinds[entry.index] ?? null,
      unstaged: kinds[entry.worktree] ?? null,
      untracked: entry.untracked,
      conflicted: entry.conflicted,
    }));
  }

  private previewUntracked(file: string): DiffInfo {
    const fullPath = path.join(this.repoPath, file);
    const info: DiffInfo = { fileName: file, changes: [], scope: 'untracked' };
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(fullPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return info; // removed since it was listed
      throw error;
    }
    if (!stats.isFile()) return info;
    const fd = fs.openSync(fullPath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stats.size, DIFF_PREVIEW_MAX_BYTES));
      const content = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0));
      if (content.includes(0)) {
        info.binary = true;
        return info;
      }
      const lines = content.toString('utf8').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      info.changes = lines.slice(0, DIFF_PREVIEW_MAX_LINES).map((text, i) => ({ line: i + 1, type: 'add' as const, content: text.replace(/\r$/, '') }));
      if (stats.size > DIFF_PREVIEW_MAX_BYTES || lines.length > DIFF_PREVIEW_MAX_LINES) info.truncated = true;
    } finally {
      fs.closeSync(fd);
    }
    return info;
  }

  /**
   * File diffs labeled by scope: `staged` (HEAD to index), `unstaged` (index to working tree) and
   * `untracked` (whole new file). scope defaults to 'all', so a partially staged file yields a staged
   * and an unstaged entry. Publishing a selected file commits its working contents (both together).
   * Binary files return empty changes with binary: true; long diffs set truncated: true.
   */
  async getDiff(filePath?: string, scope: DiffScope | 'all' = 'all'): Promise<DiffInfo[]> {
    await this.requireRepo();
    try {
      let file = '';
      if (filePath) {
        file = filePath.replace(/\\/g, '/');
        if (/[\x00-\x1f\x7f]/.test(file) || file.startsWith('-') || file.startsWith('/') || /^[a-zA-Z]:/.test(file) || file.split('/').includes('..')) {
          throw new Error('Invalid file path');
        }
      }
      const diffArgs = ['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3'];
      const pathArgs = file ? ['--', file] : ['--'];
      const diffs: DiffInfo[] = [];
      if (scope === 'all' || scope === 'staged') {
        diffs.push(...parseUnifiedDiff(await this.output([...diffArgs, '--cached', ...pathArgs], { readOnly: true }), 'staged'));
      }
      if (scope === 'all' || scope === 'unstaged') {
        diffs.push(...parseUnifiedDiff(await this.output([...diffArgs, ...pathArgs], { readOnly: true }), 'unstaged'));
      }
      if (scope === 'all' || scope === 'untracked') {
        for (const entry of (await this.workingState()).entries) {
          if (entry.untracked && !entry.path.endsWith('/') && (!file || entry.path === file)) diffs.push(this.previewUntracked(entry.path));
        }
      }
      return diffs;
    } catch (error) {
      throw new Error(`Failed to get diff: ${errorText(error)}`);
    }
  }

  /**
   * Stash management
   */
  async createStash(message?: string): Promise<void> {
    if (message !== undefined && message !== null && (typeof message !== 'string' || message.length > 1000 || /[\x00\r]/.test(message))) {
      throw new Error('Invalid stash message');
    }
    await this.ensureGitRepo();
    try {
      if (message) {
        // `-m <message>` keeps a message beginning with `-` from being parsed as an option.
        await this.git.stash(['push', '-m', message]);
      } else {
        await this.git.stash();
      }
    } catch (error) {
      throw new Error(`Failed to create stash: ${error}`);
    }
  }

  private static validateStashIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > 100000) throw new Error('Invalid stash index');
  }

  async listStashes(): Promise<StashInfo[]> {
    await this.ensureGitRepo();
    try {
      const stashList = await this.git.stashList();

      return stashList.all.map((stash, index) => ({
        index,
        hash: stash.hash,
        message: stash.message,
        date: stash.date,
      }));
    } catch (error) {
      throw new Error(`Failed to list stashes: ${error}`);
    }
  }

  async applyStash(index: number): Promise<void> {
    GitOperations.validateStashIndex(index);
    await this.ensureGitRepo();
    try {
      await this.git.stash(['apply', `stash@{${index}}`]);
    } catch (error) {
      throw new Error(`Failed to apply stash: ${error}`);
    }
  }

  async popStash(): Promise<void> {
    await this.ensureGitRepo();
    try {
      await this.git.stash(['pop']);
    } catch (error) {
      throw new Error(`Failed to pop stash: ${error}`);
    }
  }

  async dropStash(index: number): Promise<void> {
    GitOperations.validateStashIndex(index);
    await this.ensureGitRepo();
    try {
      await this.git.stash(['drop', `stash@{${index}}`]);
    } catch (error) {
      throw new Error(`Failed to drop stash: ${error}`);
    }
  }

  /**
   * Tag management
   */
  async createTag(tagName: string, message?: string): Promise<void> {
    GitOperations.validateRefName(tagName, 'tag');
    await this.ensureGitRepo();
    try {
      if (message) {
        await this.git.tag(['-a', tagName, '-m', message]);
      } else {
        await this.git.tag([tagName]);
      }
    } catch (error) {
      throw new Error(`Failed to create tag: ${error}`);
    }
  }

  async listTags(): Promise<TagInfo[]> {
    await this.ensureGitRepo();
    try {
      const tags = await this.git.tags();

      return tags.all.map(tag => ({
        name: tag,
        // We could enhance this with more tag info if needed
      }));
    } catch (error) {
      throw new Error(`Failed to list tags: ${error}`);
    }
  }

  // Tags go to the current branch's upstream remote, else origin.
  private async tagRemote(): Promise<string> {
    const branch = await this.currentBranch();
    const upstream = branch ? await this.upstreamOf(branch) : null;
    const remote = upstream?.remote ?? 'origin';
    if (!(await this.remoteNames()).includes(remote)) {
      throw new PublishError(`Remote '${remote}' is not configured; tags cannot be published.`, 'failed');
    }
    return remote;
  }

  private async listTagRefs(): Promise<TagRef[]> {
    const listed = await this.output(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)', 'refs/tags'], { readOnly: true });
    return listed.split('\n').filter(Boolean).map((line) => {
      const [ref, oid, type] = line.split('\0');
      return { name: ref.slice('refs/tags/'.length), oid, type };
    });
  }

  // An annotated tag's message is published with it, so it is screened like file content (errors only).
  private async screenTagMessages(tags: TagRef[]): Promise<FileValidationIssue[]> {
    const issues: FileValidationIssue[] = [];
    let pending = tags.filter((tag) => tag.type === 'tag').map((tag) => ({ name: tag.name, oid: tag.oid }));
    for (let depth = 0; pending.length > 0; depth++) {
      if (depth >= 16) throw new PublishError('A tag points through too many nested tag objects to inspect.', 'blocked');
      const bodies = await this.readObjects([...new Set(pending.map((entry) => entry.oid))], 'tag');
      const next: typeof pending = [];
      for (const { name, oid } of pending) {
        const body = bodies.get(oid)!;
        const reason = exclusionReason('tag-message', body.length, body);
        if (reason) {
          issues.push({
            filePath: `refs/tags/${name}`,
            severity: 'error',
            reason: `${reason} (in the tag message)`,
            sizeBytes: body.length,
            sizeMB: body.length / (1024 * 1024),
            suggestion: 'Recreate the tag without the credential.',
          });
        }
        const target = /^object ([0-9a-f]{40,64})\ntype (\w+)\n/.exec(body.toString('utf8', 0, Math.min(body.length, 512)));
        if (target && target[2] === 'tag') next.push({ name, oid: target[1] });
      }
      pending = next;
    }
    return issues;
  }

  private static describeTagPushFailure(run: GitRun, remote: string): string {
    const rejected: string[] = [];
    for (const line of run.stdout.toString('utf8').split('\n')) {
      const match = /^!\t[^:\t]+:refs\/tags\/([^\t]+)\t\[[^\]]*\](?: \(([^)]*)\))?/.exec(line.trimEnd());
      if (match) rejected.push(match[2] ? `'${match[1]}' (${match[2]})` : `'${match[1]}'`);
    }
    return rejected.length > 0
      ? `The remote ${remote} rejected tag(s) ${rejected.join(', ')}. BitGit never force-pushes tags.`
      : `Pushing tags to ${remote} failed: ${gitMessage(run)}`;
  }

  // Validates every requested tag (all local tags when `requested` is null) before any is pushed:
  // names, that each points to a commit, and every blob reachable from those commits that the remote
  // does not already have. Each tag is pushed as the exact object that was inspected (an annotated tag
  // stays annotated), without force.
  private async publishTags(requested: string[] | null, options: PublishOptions | null | undefined): Promise<void> {
    const allowWarnings = GitOperations.allowWarnings(options);
    if (requested !== null) {
      for (const name of requested) {
        try {
          GitOperations.validateRefName(name, 'tag');
        } catch (error) {
          throw new PublishError(`Tag '${String(name)}': ${errorText(error)}`, 'failed');
        }
        if ((await this.run(['check-ref-format', `refs/tags/${name}`], { readOnly: true })).code !== 0) {
          throw new PublishError(`Tag name '${name}' is not a valid Git ref name.`, 'failed');
        }
      }
    }
    await this.requireRepo();
    const remote = await this.tagRemote();
    const local = await this.listTagRefs();

    let tags: TagRef[];
    if (requested !== null) {
      tags = requested.map((name) => {
        const tag = local.find((candidate) => candidate.name === name);
        if (!tag) throw new PublishError(`Tag '${name}' does not exist.`, 'failed');
        return tag;
      });
    } else {
      const invalid = local.filter((tag) => {
        try { GitOperations.validateRefName(tag.name, 'tag'); return false; } catch { return true; }
      });
      if (invalid.length > 0) {
        throw new PublishError(
          `No tags were pushed: ${invalid.length} local tag(s) have names BitGit will not publish (${invalid.slice(0, 5).map((tag) => tag.name).join(', ')}).`,
          'failed',
        );
      }
      tags = local;
    }
    tags = [...new Map(tags.map((tag) => [tag.name, tag])).values()];
    if (tags.length === 0) return;

    const peeled = await this.run(
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      { readOnly: true, input: tags.map((tag) => `${tag.oid}^{commit}\n`).join('') },
    );
    const resolved = peeled.stdout.toString('utf8').split('\n').filter(Boolean);
    if (peeled.code !== 0 || resolved.length !== tags.length) {
      throw new PublishError(`Cannot resolve tag targets: ${gitMessage(peeled)}`, 'failed');
    }
    const commits = new Set<string>();
    const notCommits: string[] = [];
    resolved.forEach((line, i) => {
      const [oid, type] = line.split(' ');
      if (type === 'commit') commits.add(oid); else notCommits.push(tags[i].name);
    });
    if (notCommits.length > 0) {
      throw new PublishError(`No tags were pushed: ${notCommits.join(', ')} do not point to a commit and cannot be inspected.`, 'failed');
    }

    const issues = [...(await this.scanRange([...commits], [`--remotes=${remote}`])).issues, ...(await this.screenTagMessages(tags))];
    GitOperations.enforce(
      GitOperations.sortIssues(issues),
      allowWarnings,
      0,
      tags.length === 1 ? `Publishing tag '${tags[0].name}'` : `Publishing ${tags.length} tags`,
    );

    for (let i = 0; i < tags.length; i += TAG_PUSH_BATCH) {
      const batch = tags.slice(i, i + TAG_PUSH_BATCH);
      let run: GitRun;
      try {
        run = await this.run(['push', '--porcelain', remote, ...batch.map((tag) => `${tag.oid}:refs/tags/${tag.name}`)], { timeoutMs: NETWORK_TIMEOUT_MS });
      } catch (error) {
        throw new PublishError(`Pushing tags to ${remote} failed: ${errorText(error)}`, 'push-failed');
      }
      if (run.code !== 0) throw new PublishError(GitOperations.describeTagPushFailure(run, remote), 'push-failed');
    }
  }

  /**
   * Publishes one tag after the same validation as a branch push: the blobs reachable from the tag's
   * commit that the remote lacks are inspected (secrets and files over 100 MiB always block; warnings
   * need options.allowWarnings). Never forces; an existing remote tag with a different target is rejected.
   */
  async pushTag(tagName: string, options?: PublishOptions): Promise<void> {
    await this.publishTags([tagName], options);
  }

  /**
   * Publishes every local tag. All tags are validated before any is pushed, so one blocked tag
   * publishes nothing.
   */
  async pushAllTags(options?: PublishOptions): Promise<void> {
    await this.publishTags(null, options);
  }

  async deleteTag(tagName: string): Promise<void> {
    GitOperations.validateRefName(tagName, 'tag');
    await this.ensureGitRepo();
    try {
      await this.git.tag(['-d', '--', tagName]);
    } catch (error) {
      throw new Error(`Failed to delete tag: ${error}`);
    }
  }

  /**
   * Cherry-pick a commit
   */
  async cherryPick(commitHash: string): Promise<void> {
    GitOperations.validateCommitHash(commitHash);
    await this.ensureGitRepo();
    try {
      await this.git.raw(['cherry-pick', commitHash]);
    } catch (error) {
      throw new Error(`Failed to cherry-pick commit: ${error}`);
    }
  }

  /**
   * Get current branch name
   */
  async getCurrentBranch(): Promise<string> {
    await this.ensureGitRepo();
    try {
      const status = await this.git.status();
      return status.current || 'main';
    } catch (error) {
      throw new Error(`Failed to get current branch: ${error}`);
    }
  }

  // ==================== ANALYTICS ====================

  // Everything the dashboard needs from one repository, from local data only. It never fetches:
  // remote branch dates are as of the last fetch, and remote-tracking refs stay unchanged.
  async getAnalyticsSnapshot(params: AnalyticsSnapshotParams): Promise<AnalyticsSnapshot> {
    await this.ensureGitRepo();
    const options = { readOnly: true, timeoutMs: ANALYTICS_TIMEOUT_MS };
    const hasCommits = (await this.headOid()) !== null;
    const [refs, stashes, dates, recent, last] = await Promise.all([
      this.output(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(authordate:iso-strict)', 'refs/heads', 'refs/remotes', 'refs/tags'], options),
      this.output(['stash', 'list', '--format=%H'], options),
      hasCommits ? this.output(['log', '--format=%aI', `--since=${params.historySince}`], options) : '',
      hasCommits ? this.output(['log', '--numstat', '--pretty=format:COMMIT_START%n%H%n%an%n%ae%n%aI%n%s%n%D', `--max-count=${params.recentLimit}`, `--since=${params.recentSince}`], options) : '',
      hasCommits ? this.output(['log', '-1', '--format=%aI'], options) : '',
    ]);

    const daysSince = (date: string): number => Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
    const branches: BranchStaleness[] = [];
    let tagCount = 0;
    for (const line of refs.split('\n')) {
      const [ref, oid, date] = line.split('\0');
      if (!ref) continue;
      if (ref.startsWith('refs/tags/')) {
        tagCount++;
        continue;
      }
      const isRemote = ref.startsWith('refs/remotes/');
      const name = isRemote ? ref.slice('refs/remotes/'.length).replace(/^origin\//, '') : ref.slice('refs/heads/'.length);
      if (name === 'HEAD' || name.endsWith('/HEAD')) continue;
      branches.push({ name, daysSinceLastCommit: daysSince(date), isRemote, lastCommitHash: oid, lastCommitDate: date });
    }

    return {
      commitDates: dates.split('\n').filter(Boolean),
      recentCommits: this.parseGitLogNumstat(recent),
      branches,
      daysSinceLastCommit: last.trim() ? daysSince(last.trim()) : null,
      tagCount,
      stashCount: stashes.split('\n').filter(Boolean).length,
    };
  }

  private parseGitLogNumstat(output: string): AnalyticsCommit[] {
    const commits: AnalyticsCommit[] = [];
    const lines = output.split('\n');

    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();

      // Look for commit start marker
      if (line === 'COMMIT_START') {
        i++;

        // Parse commit metadata (6 lines after marker)
        if (i + 5 >= lines.length) break;

        const hash = lines[i++].trim();
        const author = lines[i++].trim();
        const email = lines[i++].trim();
        const date = lines[i++].trim();
        const message = lines[i++].trim();
        const branch = lines[i++].trim() || 'main';

        // Skip any empty lines between commit metadata and numstat
        while (i < lines.length && lines[i].trim() === '') {
          i++;
        }

        // Parse numstat lines (until next COMMIT_START)
        let filesChanged = 0;
        let additions = 0;
        let deletions = 0;

        while (i < lines.length && lines[i].trim() !== 'COMMIT_START') {
          const numstatLine = lines[i].trim();

          // Skip empty lines within numstat section
          if (numstatLine === '') {
            i++;
            continue;
          }

          const parts = numstatLine.split('\t');

          if (parts.length >= 3) {
            // Format: additions deletions filename
            const adds = parseInt(parts[0]) || 0;
            const dels = parseInt(parts[1]) || 0;

            // Skip binary files (marked with -)
            if (!isNaN(adds) && !isNaN(dels)) {
              additions += adds;
              deletions += dels;
              filesChanged++;
            }
          }
          i++;
        }

        commits.push({
          hash,
          author,
          email,
          date,
          message,
          branch,
          filesChanged,
          additions,
          deletions,
        });
      } else {
        i++;
      }
    }

    return commits;
  }
}

// Snapshots for many repositories with bounded parallelism: each one costs a handful of git processes.
export async function getAnalyticsSnapshots(repoPaths: string[], params: AnalyticsSnapshotParams): Promise<AnalyticsSnapshotResult[]> {
  const isDate = (value: unknown): boolean => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!Array.isArray(repoPaths)) throw new Error('Analytics repoPaths must be an array');
  if (!isDate(params?.historySince) || !isDate(params?.recentSince)) throw new Error('Analytics dates must be YYYY-MM-DD');
  if (!Number.isInteger(params.recentLimit) || params.recentLimit < 1 || params.recentLimit > 1000) throw new Error('Analytics recentLimit must be 1-1000');

  const results: AnalyticsSnapshotResult[] = new Array(repoPaths.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < repoPaths.length) {
      const index = next++;
      const repoPath = repoPaths[index];
      try {
        results[index] = { repoPath, snapshot: await new GitOperations(repoPath).getAnalyticsSnapshot(params) };
      } catch (error) {
        results[index] = { repoPath, error: errorText(error) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ANALYTICS_PARALLEL_REPOS, repoPaths.length) }, worker));
  return results;
}

// Standalone Git operations (not tied to a specific repository)

// Only network transports (and scp-style SSH) may be cloned or linked. `ext::` and other remote helpers,
// option-like values and control characters are refused before Git sees them.
function assertNetworkRemoteUrl(remoteUrl: unknown): asserts remoteUrl is string {
  if (typeof remoteUrl !== 'string' || !remoteUrl.trim() || remoteUrl.length > 2048 || remoteUrl.startsWith('-')
    || /[\x00-\x1f\x7f\s]/.test(remoteUrl) || /^[a-z0-9+.-]+::/i.test(remoteUrl)) {
    throw new Error('Invalid remote URL');
  }
  const scpLike = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[^\s]+$/.test(remoteUrl);
  if (!scpLike && !/^(?:https?|ssh|git):\/\/[^/\s]+/i.test(remoteUrl)) {
    throw new Error('Use an HTTPS or SSH Git remote URL');
  }
}

function assertAbsoluteLocalPath(localPath: unknown): asserts localPath is string {
  if (typeof localPath !== 'string' || !path.isAbsolute(localPath) || localPath.startsWith('-')
    || /[\x00-\x1f\x7f]/.test(localPath) || localPath.split(/[\\/]/).includes('..')) {
    throw new Error('Invalid local path: must be an absolute path');
  }
}

export async function cloneRepository(githubUrl: string, localPath: string): Promise<void> {
  try {
    assertNetworkRemoteUrl(githubUrl);
    assertAbsoluteLocalPath(localPath);
    const parent = path.dirname(localPath);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error('The destination folder does not exist');
    // `--` ends option parsing; protocol.ext.allow=never forbids the command-running ext transport.
    const run = await runGit(parent, ['-c', 'protocol.ext.allow=never', 'clone', '--', githubUrl, localPath], { timeoutMs: NETWORK_TIMEOUT_MS });
    if (run.code !== 0) throw new Error(gitMessage(run));
  } catch (error) {
    throw new Error(`Failed to clone repository: ${errorText(error)}`);
  }
}

export async function initRepository(localPath: string): Promise<void> {
  const probe = await runGit(localPath, ['rev-parse', '--is-inside-work-tree', '--show-cdup'], { readOnly: true });
  if (probe.code === 0) {
    const [inside, parent] = probe.stdout.toString('utf8').split('\n');
    if (inside.trim() !== 'true' || (parent ?? '').trim() !== '') throw new Error('Choose a repository root, not a folder inside another repository.');
    return;
  }
  if (!/not a git repository/i.test(probe.stderr)) throw new Error(`Cannot inspect repository: ${gitMessage(probe)}`);
  const initialized = await runGit(localPath, ['init', '-b', 'main']);
  if (initialized.code !== 0) throw new Error(`Failed to initialize repository: ${gitMessage(initialized)}`);
  // Initialization creates metadata only. The first commit also requires an explicit file selection.
}

export async function addRemote(localPath: string, remoteName: string, remoteUrl: string): Promise<void> {
  try {
    assertAbsoluteLocalPath(localPath);
    if (typeof remoteName !== 'string' || !/^[A-Za-z0-9][\w.-]{0,99}$/.test(remoteName)) throw new Error('Invalid remote name');
    assertNetworkRemoteUrl(remoteUrl);
    const git = simpleGit(localPath);

    // Check if remote already exists
    const remotes = await git.getRemotes(false);
    const remoteExists = remotes.some(r => r.name === remoteName);

    if (remoteExists) {
      const existingUrl = await git.remote(['get-url', remoteName]);
      if (normalizeRemoteUrl(existingUrl ?? '') !== normalizeRemoteUrl(remoteUrl)) {
        throw new Error('This remote already points to a different repository. Change it explicitly in Git before linking.');
      }
    } else {
      // `--` keeps both values positional.
      await git.raw(['remote', 'add', '--', remoteName, remoteUrl]);
    }
  } catch (error) {
    throw new Error(`Failed to add remote: ${errorText(error)}`);
  }
}

export async function pushToRemote(localPath: string, remoteName: string, branch: string, options?: PublishOptions): Promise<void> {
  try {
    GitOperations.validateRefName(branch, 'branch');
    const git = simpleGit(localPath);

    // Check current branch
    const status = await git.status();
    const currentBranch = status.current;

    if (!currentBranch) {
      throw new Error('Repository has no current branch. Make sure there is at least one commit.');
    }

    // If we're not on the target branch
    if (currentBranch !== branch) {
      // Check if target branch exists locally
      const branches = await git.branchLocal();

      if (branches.all.includes(branch)) {
        // Branch exists, checkout
        await git.checkout(branch);
      } else {
        // Branch doesn't exist, rename current branch or create new one
        if (currentBranch === 'master' && branch === 'main') {
          // Special case: rename master to main
          await git.branch(['-M', 'main']);
        } else {
          // Create new branch from current HEAD
          await git.checkoutLocalBranch(branch);
        }
      }
    }

    // Validated push with set-upstream: every blob the push would add to the remote is inspected first.
    await new GitOperations(localPath).pushExistingCommits(remoteName, branch, options);
  } catch (error) {
    throw new Error(`Failed to push to remote: ${errorText(error)}`);
  }
}
