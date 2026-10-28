import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/tauri';
import toast from 'react-hot-toast';
import {
  Project,
  SyncAction,
  PublishAction,
  SyncResult,
  FileChangeInfo,
  PreSyncValidation,
  RefreshOutcome,
  RefreshSummary,
  BulkProjectResult,
  AppSettings,
  QueuedOperation,
  RetryConfig,
  AnalyticsData,
  EditorConfig,
  EditorPreset,
  EditorAvailability,
} from '../types';

interface AppState {
  // State
  projects: Project[];
  settings: AppSettings;
  isLoading: boolean;
  selectedProjectIds: Set<string>;
  // Projects with a publish/sync/merge operation running right now
  syncingProjects: Set<string>;
  // Set by the bulk result panel to open a project's file review; the project's card clears it
  reviewRequest: { id: string; kind: PublishAction['type'] } | null;

  // Priority 6: Performance & Reliability State
  operationQueue: QueuedOperation[];
  backgroundCheckInterval: number | null;

  // Priority 1: Analytics State
  analytics: AnalyticsData | null;
  isLoadingAnalytics: boolean;

  // Project actions
  loadProjects: () => Promise<void>;
  createProject: (name: string, githubOwner?: string, githubRepo?: string, githubUrl?: string, localPath?: string) => Promise<Project>;
  updateProject: (project: Project) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  // Re-reads Git state from disk (and the remote). Never rejects: the outcome says what happened.
  refreshProject: (id: string, options?: { silent?: boolean }) => Promise<RefreshOutcome>;
  // Rejects when the operation did not succeed; a resolved result may still be a no-op.
  syncProject: (id: string, action: SyncAction, retry?: RetryConfig) => Promise<SyncResult>;
  requestReview: (request: { id: string; kind: PublishAction['type'] } | null) => void;

  // Legacy aliases for compatibility
  repositories: Project[];
  loadRepositories: () => Promise<void>;
  syncRepository: (id: string, action: SyncAction) => Promise<SyncResult>;
  removeRepository: (id: string) => void;

  // Selection actions
  toggleSelection: (id: string) => void;
  selectAll: (ids?: string[]) => void;
  clearSelection: () => void;

  // Settings actions
  updateSettings: (settings: Partial<AppSettings>) => void;
  saveGitHubToken: (username: string, token: string) => Promise<void>;
  toggleTheme: () => void;

  // Editor settings actions
  loadEditorSettings: () => Promise<void>;
  saveEditorSettings: (preset: EditorPreset, customCommand?: string) => Promise<void>;
  detectInstalledEditors: () => Promise<EditorAvailability>;

  // Batch publishing: only clean projects are published (no file selection exists for a batch);
  // projects with uncommitted changes, warnings or blocking issues are reported, never forced.
  syncSelected: (action: PublishAction, maxConcurrent?: number) => Promise<BulkProjectResult[]>;

  // Priority 6: Performance & Reliability Actions
  startBackgroundChecking: () => void;
  stopBackgroundChecking: () => void;
  // Checks every project that has a local folder, GitHub link or not.
  refreshAllProjects: () => Promise<RefreshSummary>;
  queueOperation: (projectId: string, action: SyncAction) => void;
  cancelOperation: (operationId: string) => void;
  retryOperation: (operationId: string) => Promise<void>;
  clearCompletedOperations: () => void;
  syncSelectedParallel: (action: PublishAction, maxConcurrent?: number) => Promise<BulkProjectResult[]>;

  // Priority 1: Analytics Actions
  loadAnalytics: () => Promise<void>;
}

const defaultSettings: AppSettings = {
  github: {
    username: '',
    hasToken: false,
  },
  scanning: {
    directories: [],
    depth: 3,
    excludePatterns: ['node_modules', '.git', 'target', 'dist', 'build'],
  },
  ui: {
    theme: 'system',
    refreshInterval: 5 * 60 * 1000, // 5 minutes default
    showNotifications: true,
    editor: {
      preset: 'vscode',
      customCommand: undefined,
    },
  },
};

// Helper function for retry with exponential backoff
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  config: RetryConfig = { maxAttempts: 3, delayMs: 1000, backoffMultiplier: 2 }
): Promise<T> => {
  let lastError: Error | unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      if (attempt < config.maxAttempts) {
        const delayTime = config.delayMs * Math.pow(config.backoffMultiplier, attempt - 1);
        console.log(`Attempt ${attempt} failed, retrying in ${delayTime}ms...`);
        await delay(delayTime);
      }
    }
  }

  throw lastError;
};

// Helper function for parallel execution with concurrency limit
const parallelLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> => {
  const results: PromiseSettledResult<R>[] = [];

  // Process items in chunks to maintain concurrency limit
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.allSettled(chunk.map(fn));
    results.push(...chunkResults);
  }

  return results;
};

const SYNC_LABELS: Record<SyncAction['type'], string> = {
  push_local: 'Push',
  full_sync: 'Full sync',
  merge_branches: 'Merge',
  pull_branches: 'Pull',
};

export const syncActionLabel = (action: SyncAction): string => SYNC_LABELS[action.type];

// True only when data actually moved to or from the remote (or branches were integrated).
export function syncMovedData(action: SyncAction, result: SyncResult): boolean {
  const d = result.details;
  switch (action.type) {
    case 'push_local':
      return (d.pushed ?? 0) > 0;
    case 'full_sync':
      return (d.pushed ?? 0) > 0 || (d.pulled ?? 0) > 0;
    default:
      return (d.merged?.length ?? 0) > 0;
  }
}

// Text for a successful call, from what the service reported. A backend that still reports
// removed branches gets them named rather than hidden.
export function describeSyncResult(action: SyncAction, result: SyncResult): string {
  if (action.type === 'merge_branches' || action.type === 'pull_branches') {
    const merged = result.details.merged ?? [];
    if (merged.length === 0) return result.message;
    const verb = action.type === 'merge_branches' ? 'Merged' : 'Pulled';
    const removed = result.details.deleted ?? [];
    return `${verb} ${merged.join(', ')} into your current branch.${removed.length ? ` Also removed: ${removed.join(', ')}.` : ''}`;
  }
  return result.message;
}

// Text for a call that did not succeed. The service says whether work was committed locally.
function describeSyncFailure(result: SyncResult): string {
  const extra = (result.details.errors ?? []).filter((e) => e && e !== result.message);
  return [result.message, ...extra].join(' ');
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function issueSummary(validation: PreSyncValidation, severity: 'error' | 'warning'): string {
  const matching = validation.issues.filter((i) => i.severity === severity);
  const shown = matching.slice(0, 3).map((i) => `${i.filePath} (${i.reason})`).join('; ');
  return `${shown}${matching.length > 3 ? `; and ${matching.length - 3} more` : ''}`;
}

export const useAppStore = create<AppState>((set, get) => {
  const setSyncing = (id: string, active: boolean) =>
    set((state) => {
      const next = new Set(state.syncingProjects);
      if (active) next.add(id);
      else next.delete(id);
      return { syncingProjects: next };
    });

  // Runs one sync call without any toast. Local state is re-read afterwards even on failure,
  // because a failed push can still leave a local commit behind.
  const runSync = async (id: string, action: SyncAction, retryConfig?: RetryConfig): Promise<SyncResult> => {
    const execute = async () => {
      const result = await invoke<SyncResult>('sync_project', { projectId: id, action });
      if (!result.success) throw new Error(describeSyncFailure(result));
      return result;
    };
    setSyncing(id, true);
    try {
      const result = await (retryConfig ? retryWithBackoff(execute, retryConfig) : execute());
      await get().refreshProject(id, { silent: true });
      return result;
    } catch (error) {
      await get().refreshProject(id, { silent: true });
      throw error;
    } finally {
      setSyncing(id, false);
    }
  };

  // One project of a batch. Never stages anything: dirty projects are handed back for review.
  const publishCleanProject = async (project: Project, action: PublishAction): Promise<BulkProjectResult> => {
    const base = { projectId: project.id, name: project.name };
    if (!project.localPath) {
      return { ...base, outcome: 'skipped', message: 'No local folder is linked.' };
    }
    if (!project.githubUrl) {
      return { ...base, outcome: 'skipped', message: 'Not linked to GitHub, so there is nowhere to publish.' };
    }

    let changes: FileChangeInfo[];
    try {
      changes = await invoke<FileChangeInfo[]>('git_get_file_changes', { repoPath: project.localPath });
    } catch (error) {
      return { ...base, outcome: 'failed', message: `Could not read the changed files, so nothing was published: ${errorText(error)}` };
    }
    if (changes.length > 0) {
      return {
        ...base,
        outcome: 'needs_review',
        message: `${changes.length} file(s) have uncommitted changes. Open the project and choose which files to publish.`,
      };
    }

    let validation: PreSyncValidation;
    try {
      validation = await invoke<PreSyncValidation>('validate_before_sync', {
        projectId: project.id,
        selectedFiles: null,
      });
    } catch (error) {
      return { ...base, outcome: 'failed', message: `Could not check the files first, so nothing was published: ${errorText(error)}` };
    }
    if (!validation.canProceed) {
      return { ...base, outcome: 'blocked', message: `Blocked: ${issueSummary(validation, 'error') || 'validation did not pass'}.` };
    }
    if (validation.hasWarnings) {
      return { ...base, outcome: 'needs_review', message: `Warnings need your review: ${issueSummary(validation, 'warning')}.` };
    }

    const plain: PublishAction = { type: action.type };
    try {
      const result = await runSync(project.id, plain);
      return syncMovedData(plain, result)
        ? { ...base, outcome: 'published', message: describeSyncResult(plain, result) }
        : { ...base, outcome: 'up_to_date', message: describeSyncResult(plain, result) };
    } catch (error) {
      return { ...base, outcome: 'failed', message: errorText(error) };
    }
  };

  const runBulk = async (action: PublishAction, maxConcurrent: number): Promise<BulkProjectResult[]> => {
    const selectedIds = Array.from(get().selectedProjectIds);
    if (selectedIds.length === 0) {
      toast.error('No projects selected');
      return [];
    }

    const label = action.type === 'full_sync' ? 'sync' : 'push';
    const loadingToastId = toast.loading(`Checking ${selectedIds.length} project(s) before they ${label}...`);
    const settled = await parallelLimit(selectedIds, maxConcurrent, async (id) => {
      const project = get().projects.find((p) => p.id === id);
      if (!project) {
        return { projectId: id, name: id, outcome: 'skipped', message: 'Project not found.' } as BulkProjectResult;
      }
      return publishCleanProject(project, action);
    });

    const results = settled.map((entry, i) =>
      entry.status === 'fulfilled'
        ? entry.value
        : ({ projectId: selectedIds[i], name: selectedIds[i], outcome: 'failed', message: errorText(entry.reason) } as BulkProjectResult)
    );

    const count = (outcome: BulkProjectResult['outcome']) => results.filter((r) => r.outcome === outcome).length;
    const published = count('published');
    const parts = [
      published && `${published} published`,
      count('up_to_date') && `${count('up_to_date')} already up to date (nothing sent)`,
      count('needs_review') && `${count('needs_review')} need your review`,
      count('blocked') && `${count('blocked')} blocked`,
      count('failed') && `${count('failed')} failed`,
      count('skipped') && `${count('skipped')} skipped`,
    ].filter(Boolean);
    const summary = parts.join(', ');
    const problems = count('blocked') + count('failed');

    if (problems > 0) {
      toast.error(`${summary}. See the results below.`, { id: loadingToastId, duration: 8000 });
    } else if (published > 0 && published + count('up_to_date') === results.length) {
      toast.success(summary, { id: loadingToastId });
    } else {
      toast(`${summary}.`, { id: loadingToastId, duration: 6000 });
    }
    return results;
  };

  return {
  // Initial state
  projects: [],
  settings: defaultSettings,
  isLoading: false,
  selectedProjectIds: new Set(),
  syncingProjects: new Set(),
  reviewRequest: null,
  operationQueue: [],
  backgroundCheckInterval: null,
  analytics: null,
  isLoadingAnalytics: false,

  // Load projects from cache
  loadProjects: async () => {
    console.log('[Store] loadProjects called');
    set({ isLoading: true });
    try {
      console.log('[Store] Invoking load_projects...');
      const projects = await invoke<Project[]>('load_projects');
      console.log('[Store] Received projects:', projects);
      set({ projects, isLoading: false });
      console.log('[Store] State updated successfully');
    } catch (error) {
      console.error('[Store] Failed to load projects:', error);
      toast.error('Failed to load projects');
      set({ isLoading: false });
    }
  },

  // Create a new project
  createProject: async (name: string, githubOwner?: string, githubRepo?: string, githubUrl?: string, localPath?: string) => {
    try {
      const project = await invoke<Project>('create_project', {
        name,
        githubOwner: githubOwner || null,
        githubRepo: githubRepo || null,
        githubUrl: githubUrl || null,
        localPath: localPath || null,
      });

      set((state) => ({
        projects: [...state.projects, project],
      }));

      toast.success(`Project "${name}" created`);

      // Automatically check git status for any project with a local folder
      if (project.localPath) {
        // Use setTimeout to let the UI update first, then check status
        setTimeout(() => {
          get().refreshProject(project.id).catch((err) => {
            console.error('Failed to auto-refresh project status:', err);
          });
        }, 100);
      }

      return project;
    } catch (error: any) {
      console.error('Failed to create project:', error);
      toast.error(`Failed to create project: ${error}`);
      throw error;
    }
  },

  // Update an existing project
  updateProject: async (project: Project) => {
    try {
      const updated = await invoke<Project>('update_project', { project });

      set((state) => ({
        projects: state.projects.map((p) => (p.id === updated.id ? updated : p)),
      }));

      toast.success(`Project "${project.name}" updated`);
    } catch (error: any) {
      console.error('Failed to update project:', error);
      toast.error(`Failed to update project: ${error}`);
      throw error;
    }
  },

  // Delete a project
  deleteProject: async (id: string) => {
    const project = get().projects.find((p) => p.id === id);
    if (!project) return;

    try {
      await invoke('delete_project', { projectId: id });

      set((state) => ({
        projects: state.projects.filter((p) => p.id !== id),
        selectedProjectIds: new Set([...state.selectedProjectIds].filter((sid) => sid !== id)),
      }));

      toast.success(`Project "${project.name}" deleted`);
    } catch (error: any) {
      console.error('Failed to delete project:', error);
      toast.error(`Failed to delete project: ${error}`);
      throw error;
    }
  },

  // Re-read a project's Git state. Any project with a local folder is checked, GitHub link or not.
  refreshProject: async (id: string, options?: { silent?: boolean }): Promise<RefreshOutcome> => {
    const project = get().projects.find((p) => p.id === id);
    if (!project) return { status: 'failed', error: 'Project not found.' };
    if (!project.localPath) return { status: 'skipped', reason: 'No local folder is linked.' };

    try {
      const updated = await invoke<Project>('check_project_status', { projectId: id });
      set((state) => ({
        projects: state.projects.map((p) => (p.id === id ? updated : p)),
      }));

      const git = updated.gitStatus;
      if (git && !git.isGitRepo) {
        return { status: 'unavailable', project: updated, cause: 'not_git', reason: 'This folder is not a Git repository.' };
      }
      // The native side stores a failed check as "unavailable" instead of rejecting, so the
      // remote error has to be read from the status rather than from a thrown error.
      if (git && (git.syncStatus === 'unavailable' || git.remoteError)) {
        return { status: 'unavailable', project: updated, cause: 'remote', reason: git.remoteError ?? 'GitHub could not be read.' };
      }
      return { status: 'ok', project: updated };
    } catch (error) {
      console.error('[Store] Failed to refresh project:', error);
      if (!options?.silent) toast.error(`Failed to refresh project status: ${errorText(error)}`);
      return { status: 'failed', error: errorText(error) };
    }
  },

  requestReview: (request) => set({ reviewRequest: request }),

  // Sync a project with given action (with optional retry)
  syncProject: async (id: string, action: SyncAction, retryConfig?: RetryConfig) => {
    const project = get().projects.find((p) => p.id === id);
    if (!project) throw new Error('Project not found.');

    const label = syncActionLabel(action);
    const loadingToast = toast.loading(`${label} in progress...`);

    try {
      const result = await runSync(id, action, retryConfig);
      const text = describeSyncResult(action, result);
      if (syncMovedData(action, result)) {
        toast.success(text, { id: loadingToast });
      } else {
        toast(text, { id: loadingToast });
      }
      return result;
    } catch (error) {
      console.error('Sync failed:', error);
      toast.error(`${label} failed: ${errorText(error)}`, { id: loadingToast, duration: 8000 });
      throw error;
    }
  },

  // Legacy aliases for compatibility
  get repositories() {
    return get().projects;
  },
  loadRepositories: () => get().loadProjects(),
  syncRepository: (id: string, action: SyncAction) => get().syncProject(id, action),
  removeRepository: (id: string) => get().deleteProject(id),

  // Selection management
  toggleSelection: (id: string) => {
    set((state) => {
      const newSelection = new Set(state.selectedProjectIds);
      if (newSelection.has(id)) {
        newSelection.delete(id);
      } else {
        newSelection.add(id);
      }
      return { selectedProjectIds: newSelection };
    });
  },

  // Pass the ids on screen. With no list, every project is selected.
  selectAll: (ids?: string[]) => {
    set((state) => ({
      selectedProjectIds: new Set(ids ?? state.projects.map((project) => project.id)),
    }));
  },

  clearSelection: () => {
    set({ selectedProjectIds: new Set() });
  },

  // Update settings
  updateSettings: (newSettings: Partial<AppSettings>) => {
    set((state) => ({
      settings: { ...state.settings, ...newSettings },
    }));
  },

  // Toggle theme (simple 2-state: light <-> dark)
  toggleTheme: () => {
    set((state) => {
      const currentTheme = state.settings.ui.theme;

      // Determine actual current theme (resolve 'system' to actual preference)
      let actualCurrentTheme = currentTheme;
      if (currentTheme === 'system') {
        actualCurrentTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }

      // Toggle to opposite theme
      const newTheme = actualCurrentTheme === 'dark' ? 'light' : 'dark';

      // Apply theme to document
      if (newTheme === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }

      return {
        settings: {
          ...state.settings,
          ui: { ...state.settings.ui, theme: newTheme },
        },
      };
    });
  },

  // Load editor settings from disk
  loadEditorSettings: async () => {
    try {
      const editorConfig = await invoke<EditorConfig>('load_editor_settings');
      set((state) => ({
        settings: {
          ...state.settings,
          ui: { ...state.settings.ui, editor: editorConfig },
        },
      }));
    } catch (error) {
      console.error('Failed to load editor settings:', error);
      // Keep default settings on error
    }
  },

  // Save editor settings to disk
  saveEditorSettings: async (preset: EditorPreset, customCommand?: string) => {
    try {
      await invoke('save_editor_settings', { preset, customCommand: customCommand || null });
      set((state) => ({
        settings: {
          ...state.settings,
          ui: { ...state.settings.ui, editor: { preset, customCommand } },
        },
      }));
      toast.success('Editor preference saved');
    } catch (error) {
      console.error('Failed to save editor settings:', error);
      toast.error('Failed to save editor preference');
      throw error;
    }
  },

  // Detect which editors are installed
  detectInstalledEditors: async () => {
    try {
      return await invoke<EditorAvailability>('detect_installed_editors');
    } catch (error) {
      console.error('Failed to detect editors:', error);
      return { vscode: false, cursor: false, sublime: false };
    }
  },

  // Save GitHub token securely
  saveGitHubToken: async (username: string, token: string) => {
    try {
      await invoke('save_github_token', { username, token });
      set((state) => ({
        settings: {
          ...state.settings,
          github: { username, hasToken: true },
        },
      }));
      toast.success('GitHub token saved securely');
    } catch (error) {
      console.error('Failed to save token:', error);
      toast.error('Failed to save GitHub token');
      throw error;
    }
  },

  // Batch publish of the selected projects; see AppState.syncSelected
  syncSelected: (action: PublishAction, maxConcurrent = 3) => runBulk(action, maxConcurrent),

  // ===== Priority 6: Performance & Reliability =====

  // Start background status checking
  startBackgroundChecking: () => {
    const interval = get().settings.ui.refreshInterval;
    if (interval <= 0) return;

    // Clear existing interval if any
    get().stopBackgroundChecking();

    const intervalId = window.setInterval(() => {
      console.log('[Background] Running scheduled status check...');
      get().refreshAllProjects();
    }, interval);

    set({ backgroundCheckInterval: intervalId });
    console.log(`[Background] Status checking started (every ${interval / 1000}s)`);
  },

  // Stop background status checking
  stopBackgroundChecking: () => {
    const intervalId = get().backgroundCheckInterval;
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      set({ backgroundCheckInterval: null });
      console.log('[Background] Status checking stopped');
    }
  },

  // Re-read every project that has a local folder, in parallel. Projects with an operation
  // running are left alone so a status write cannot race it.
  refreshAllProjects: async (): Promise<RefreshSummary> => {
    const summary: RefreshSummary = { checked: 0, ok: 0, unavailable: 0, failed: 0, skipped: 0 };
    const projects = get().projects.filter((p) => p.localPath);
    if (projects.length === 0) return summary;

    await parallelLimit(
      projects,
      5, // Max 5 concurrent refreshes
      async (project) => {
        if (get().syncingProjects.has(project.id)) {
          summary.skipped++;
          return;
        }
        const outcome = await get().refreshProject(project.id, { silent: true });
        summary.checked++;
        if (outcome.status === 'ok') summary.ok++;
        else if (outcome.status === 'unavailable') summary.unavailable++;
        else if (outcome.status === 'failed') summary.failed++;
        else summary.skipped++;
      }
    );

    console.log('[Background] Refreshed projects', summary);
    return summary;
  },

  // Same publishing rules as syncSelected; kept for callers of the older name
  syncSelectedParallel: (action: PublishAction, maxConcurrent = 3) => runBulk(action, maxConcurrent),

  // Queue an operation
  queueOperation: (projectId: string, action: SyncAction) => {
    const project = get().projects.find(p => p.id === projectId);
    if (!project) return;

    const operation: QueuedOperation = {
      id: `${Date.now()}-${Math.random()}`,
      projectId,
      projectName: project.name,
      action,
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
    };

    set((state) => ({
      operationQueue: [...state.operationQueue, operation],
    }));

    toast.success(`Operation queued for ${project.name}`);
  },

  // Cancel an operation
  cancelOperation: (operationId: string) => {
    set((state) => ({
      operationQueue: state.operationQueue.map(op =>
        op.id === operationId && op.status === 'pending'
          ? { ...op, status: 'cancelled' as const }
          : op
      ),
    }));
    toast('Operation cancelled');
  },

  // Retry a failed operation
  retryOperation: async (operationId: string) => {
    const operation = get().operationQueue.find(op => op.id === operationId);
    if (!operation || operation.status !== 'failed') return;

    // Update operation status to pending
    set((state) => ({
      operationQueue: state.operationQueue.map(op =>
        op.id === operationId
          ? { ...op, status: 'pending' as const, error: undefined }
          : op
      ),
    }));

    // Execute the operation
    try {
      set((state) => ({
        operationQueue: state.operationQueue.map(op =>
          op.id === operationId
            ? { ...op, status: 'running' as const, startedAt: new Date().toISOString(), attempts: op.attempts + 1 }
            : op
        ),
      }));

      await get().syncProject(operation.projectId, operation.action);

      set((state) => ({
        operationQueue: state.operationQueue.map(op =>
          op.id === operationId
            ? { ...op, status: 'completed' as const, completedAt: new Date().toISOString() }
            : op
        ),
      }));

      toast.success(`Retry successful for ${operation.projectName}`);
    } catch (error: any) {
      set((state) => ({
        operationQueue: state.operationQueue.map(op =>
          op.id === operationId
            ? { ...op, status: 'failed' as const, error: error.message || String(error) }
            : op
        ),
      }));

      toast.error(`Retry failed for ${operation.projectName}`);
    }
  },

  // Clear completed operations
  clearCompletedOperations: () => {
    set((state) => ({
      operationQueue: state.operationQueue.filter(
        op => op.status !== 'completed' && op.status !== 'cancelled'
      ),
    }));
  },

  // ===== Priority 1: Analytics =====

  // Keeps the previous result on screen while a newer one loads: revisiting the tab must not blank it.
  loadAnalytics: async () => {
    if (get().isLoadingAnalytics) return;
    set({ isLoadingAnalytics: true });
    try {
      const analytics = await invoke<AnalyticsData>('generate_analytics');
      set({ analytics });
    } catch (error) {
      console.error('[Store] Failed to load analytics:', error);
      toast.error(`Failed to load analytics: ${error}`);
    } finally {
      set({ isLoadingAnalytics: false });
    }
  },
  };
});
