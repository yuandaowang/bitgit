import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Project, PublishAction, SyncAction, SyncResult, FileChangeInfo, PreSyncValidation } from '../types';
import { useAppStore, describeSyncResult, syncMovedData, syncActionLabel } from '../stores/useAppStore';
import { invoke } from '@tauri-apps/api/tauri';
import { open } from '@tauri-apps/api/dialog';
import toast from 'react-hot-toast';
import { joinPath } from '../lib/paths';
import { LinkLocalModal } from './LinkLocalModal';
import { LinkGitHubModal } from './LinkGitHubModal';
import { CreateRepoModal } from './CreateRepoModal';
import { ProjectDetails } from './ProjectDetails';
import { ValidationWarningModal } from './ValidationWarningModal';
import { CommitModal } from './CommitModal';
import { BranchIntegrationModal } from './git/BranchIntegrationModal';
import { GitStatusSummary } from './git/GitStatusSummary';
import { formatRelativeTime, getCardStatus, remoteTarget, type CardStatus, CardTone } from './git/gitStatusView';
import { open as openExternal } from '@tauri-apps/api/shell';
import { RecoveryWorkspace } from './recovery/RecoveryWorkspace';
import { ProjectLabels } from './ProjectLabels';
import {
  GitBranch,
  CheckCircle,
  AlertCircle,
  Clock,
  Code,
  Upload,
  GitMerge,
  RefreshCw,
  FolderGit,
  Github,
  Link as LinkIcon,
  Download,
  Trash2,
  RotateCw,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  Star,
  Archive,
  Edit2,
  Save,
  X,
  ExternalLink,
  History as HistoryIcon,
  ArrowUp,
  ArrowDown,
  FileDiff,
} from 'lucide-react';

interface ProjectCardProps {
  project: Project;
  density?: 'detail' | 'simple';
  labelCatalog?: string[];
}

interface CardMenuItem {
  id: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

function SyncCount({
  value,
  tip,
  hot,
  icon: Icon,
}: {
  value: number;
  tip: string;
  hot: boolean;
  icon: typeof ArrowUp;
}) {
  return (
    <IconTip tip={tip} align="center">
      <span
        aria-label={tip}
        className={`inline-flex items-center gap-0.5 ${hot ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-gray-400'}`}
      >
        <Icon className="w-3.5 h-3.5" aria-hidden="true" />
        <span className="tabular-nums">{value}</span>
      </span>
    </IconTip>
  );
}

// Branch, ahead/behind and uncommitted files. Quiet when zero, emphasized when there is something to do.
function CompactSync({ project }: { project: Project }) {
  const git = project.gitStatus;
  if (!git) return null;
  if (!git.isGitRepo) {
    return <p className="text-sm font-medium text-gray-500 dark:text-gray-400" data-testid="compact-sync">未连接</p>;
  }

  const branch = git.currentBranch ?? 'detached';
  const ahead = git.unpushedCommits;
  const behind = git.behindCommits ?? 0;
  const uncommitted = git.uncommittedFiles;
  const connected = Boolean(git.hasRemote && git.upstream);

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm min-w-0" data-testid="compact-sync">
      <span className="font-semibold font-mono text-gray-900 dark:text-white truncate">{branch}</span>
      {connected ? (
        <>
          <SyncCount value={ahead} tip={`${ahead} commit${ahead === 1 ? '' : 's'} ahead of Remote`} hot={ahead > 0} icon={ArrowUp} />
          <SyncCount value={behind} tip={`${behind} commit${behind === 1 ? '' : 's'} behind Remote`} hot={behind > 0} icon={ArrowDown} />
        </>
      ) : (
        <span className="font-medium text-gray-500 dark:text-gray-400">未连接</span>
      )}
      <SyncCount
        value={uncommitted}
        tip={`${uncommitted} uncommitted file${uncommitted === 1 ? '' : 's'}`}
        hot={uncommitted > 0}
        icon={FileDiff}
      />
    </p>
  );
}

type NoticeTone = 'success' | 'neutral' | 'error';

// The last thing that happened on this card, kept on screen (a toast disappears) until the next action.
interface Notice {
  tone: NoticeTone;
  title: string;
  detail?: string;
}

const NOTICE_STYLE: Record<NoticeTone, string> = {
  success: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-200',
  neutral: 'bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300',
  error: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200',
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function StatusLabel({ project, cardStatus, compact = false }: { project: Project; cardStatus: CardStatus; compact?: boolean }) {
  const remote = cardStatus.tone === 'local_only' ? remoteTarget(project.gitStatus?.remoteUrl) : null;
  if (remote) {
    return (
      <button
        type="button"
        data-testid="status-text"
        className={`${compact ? 'text-xs' : 'text-sm'} max-w-full truncate text-left font-medium text-teal-700 hover:underline dark:text-teal-300`}
        onClick={() => void openExternal(remote.href).catch(() => window.open(remote.href, '_blank', 'noopener,noreferrer'))}
      >
        {remote.label}
      </button>
    );
  }
  return (
    <p className={`${compact ? 'text-xs' : 'text-sm'} text-gray-500 dark:text-gray-400 truncate`} data-testid="status-text">
      {cardStatus.text}
    </p>
  );
}

// Native title tips do not appear in the macOS window, so icon buttons draw their own.
function IconTip({ tip, children, align = 'end' }: { tip: string; align?: 'end' | 'center'; children: ReactNode }) {
  const position = align === 'center' ? 'left-1/2 -translate-x-1/2' : 'right-0';
  return (
    <span className="relative inline-flex group/tip">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-full ${position} z-30 mt-1.5 hidden whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-xs font-medium text-white shadow-lg group-hover/tip:block group-focus-within/tip:block dark:bg-gray-100 dark:text-gray-900`}
      >
        {tip}
      </span>
    </span>
  );
}

export function ProjectCard({ project, density = 'detail', labelCatalog = [] }: ProjectCardProps) {
  const {
    syncProject,
    toggleSelection,
    selectedProjectIds,
    deleteProject,
    updateProject,
    refreshProject,
    settings,
    syncingProjects,
    reviewRequest,
    requestReview,
  } = useAppStore();
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showLinkLocalModal, setShowLinkLocalModal] = useState(false);
  const [showLinkGitHubModal, setShowLinkGitHubModal] = useState(false);
  const [showCreateRepoModal, setShowCreateRepoModal] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [descriptionText, setDescriptionText] = useState(project.description || '');
  // What is waiting on the validation modal: the exact action (with its exact file list) that was validated
  const [pending, setPending] = useState<{ action: PublishAction; validation: PreSyncValidation } | null>(null);
  const [commitKind, setCommitKind] = useState<PublishAction['type'] | null>(null);
  const [reloadSignal, setReloadSignal] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [integrationMode, setIntegrationMode] = useState<'merge_branches' | 'pull_branches' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isSelected = selectedProjectIds.has(project.id);
  const isFavorite = project.favorite || false;
  const isArchived = project.archived || false;
  const isBusy = isLoading || isCommitting || syncingProjects.has(project.id);
  const cardStatus = getCardStatus(project);

  // Advanced Git views need a local Git folder; a GitHub link is not required.
  const canShowDetails = Boolean(project.localPath) && project.gitStatus?.isGitRepo !== false;

  const handleRefreshStatus = async () => {
    setIsRefreshing(true);
    try {
      const outcome = await refreshProject(project.id);
      if (outcome.status === 'ok') {
        toast.success('Status refreshed', { duration: 2000 });
      } else if (outcome.status === 'unavailable') {
        // Checked, but the answer is incomplete: never reported as a success.
        if (outcome.cause === 'not_git') toast(outcome.reason);
        else toast.error(`Status could not be fully checked: ${outcome.reason}`, { duration: 6000 });
      } else if (outcome.status === 'skipped') {
        toast(outcome.reason);
      }
      // A failed refresh has already been reported by the store.
    } finally {
      setIsRefreshing(false);
    }
  };

  const reportResult = (action: SyncAction, result: SyncResult) => {
    const moved = syncMovedData(action, result);
    setNotice({
      tone: moved ? 'success' : 'neutral',
      title: moved ? `${syncActionLabel(action)} finished` : `${syncActionLabel(action)}: nothing was sent or merged`,
      detail: describeSyncResult(action, result),
    });
  };

  // Runs one sync action and keeps the outcome on the card. Returns whether it succeeded.
  const runAction = async (action: SyncAction): Promise<boolean> => {
    setNotice(null);
    try {
      const result = await syncProject(project.id, action);
      reportResult(action, result);
      return true;
    } catch (error) {
      setNotice({ tone: 'error', title: `${syncActionLabel(action)} did not complete`, detail: errorText(error) });
      return false;
    }
  };

  // Validates the exact action, then either publishes, or hands the result to the validation modal.
  // Any failure to validate stops here: nothing is published on an unchecked selection.
  type PublishStep = 'published' | 'failed' | 'needs_review' | 'check_failed';
  const validateAndPublish = async (action: PublishAction): Promise<PublishStep> => {
    setNotice(null);
    let validation: PreSyncValidation;
    try {
      validation = await invoke<PreSyncValidation>('validate_before_sync', {
        projectId: project.id,
        selectedFiles: action.selectedFiles ?? null,
      });
    } catch (error) {
      const detail = `BitGit could not check the files first, so nothing was published: ${errorText(error)}`;
      setNotice({ tone: 'error', title: 'Nothing was published', detail });
      setSubmitError(detail);
      return 'check_failed';
    }

    if (!validation.canProceed || validation.hasWarnings) {
      setPending({ action, validation });
      return 'needs_review';
    }
    return (await runAction(action)) ? 'published' : 'failed';
  };

  // Push Local / Sync All. Dirty folders need a reviewed file selection; clean ones publish what is already committed.
  const startPublish = async (kind: PublishAction['type']) => {
    if (!project.localPath) return;
    setIsLoading(true);
    setNotice(null);
    let changes: FileChangeInfo[];
    try {
      changes = await invoke<FileChangeInfo[]>('git_get_file_changes', { repoPath: project.localPath });
    } catch (error) {
      setNotice({
        tone: 'error',
        title: 'Nothing was published',
        detail: `BitGit could not read the changed files: ${errorText(error)}`,
      });
      setIsLoading(false);
      return;
    }

    if (changes.length > 0) {
      setSubmitError(null);
      setCommitKind(kind);
      setIsLoading(false);
      return;
    }
    try {
      await validateAndPublish({ type: kind });
    } finally {
      setIsLoading(false);
    }
  };

  const handleModalSubmit = async (message: string, description: string | undefined, selectedFiles: string[]) => {
    if (!commitKind) return;
    setSubmitError(null);
    setIsCommitting(true);
    try {
      const step = await validateAndPublish({
        type: commitKind,
        commitMessage: message,
        commitDescription: description,
        selectedFiles: selectedFiles.length > 0 ? selectedFiles : undefined,
      });
      // With a review pending the commit dialog stays underneath so Cancel returns to the same selection.
      if (step === 'published' || step === 'failed') setCommitKind(null);
    } finally {
      setIsCommitting(false);
    }
  };

  const handleProceedWithWarnings = async () => {
    if (!pending) return;
    // Same files, same action; warnings are allowed for this attempt only.
    const action: PublishAction = { ...pending.action, allowWarnings: pending.validation.hasWarnings };
    setPending(null);
    setIsCommitting(true);
    try {
      await runAction(action);
      setCommitKind(null);
    } finally {
      setIsCommitting(false);
    }
  };

  const handleGitignoreUpdated = () => {
    // The ignored files may no longer be pending: go back to the file list and read it again.
    setPending(null);
    if (commitKind) {
      setReloadSignal((n) => n + 1);
    } else {
      void startPublish(pending?.action.type ?? 'push_local');
    }
  };

  const handleIntegrate = async (branches: string[]) => {
    if (!integrationMode) return;
    const action: SyncAction = { type: integrationMode, branches };
    setIsCommitting(true);
    try {
      await runAction(action);
      setIntegrationMode(null);
    } finally {
      setIsCommitting(false);
    }
  };

  // Opened from the bulk result panel for a project that needs its files reviewed.
  useEffect(() => {
    if (reviewRequest && reviewRequest.id === project.id) {
      requestReview(null);
      cardRef.current?.scrollIntoView?.({ block: 'center' });
      void startPublish(reviewRequest.kind);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewRequest]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const handleDelete = async () => {
    // Show confirmation dialog BEFORE doing anything
    const confirmed = window.confirm(`Are you sure you want to delete project "${project.name}"?\n\nThis will only remove the project from BitGit. Your files and GitHub repository will not be affected.`);

    if (!confirmed) {
      return; // User cancelled, don't delete
    }

    // User confirmed, proceed with deletion
    try {
      await deleteProject(project.id);
    } catch (error) {
      console.error('Failed to delete project:', error);
      // Error toast is already shown by the store
    }
  };

  const handleToggleFavorite = async () => {
    try {
      const updatedProject = await invoke<Project>('toggle_project_favorite', {
        projectId: project.id,
      });
      updateProject(updatedProject);
      toast.success(updatedProject.favorite ? 'Added to favorites' : 'Removed from favorites', { duration: 2000 });
    } catch (error: any) {
      toast.error(`Failed to update favorite: ${error}`);
    }
  };

  const handleToggleArchive = async () => {
    try {
      const updatedProject = await invoke<Project>('toggle_project_archived', {
        projectId: project.id,
      });
      updateProject(updatedProject);
      toast.success(updatedProject.archived ? 'Project archived' : 'Project restored', { duration: 2000 });
    } catch (error: any) {
      toast.error(`Failed to update archive status: ${error}`);
    }
  };

  const handleSaveDescription = async () => {
    try {
      const updatedProject = await invoke<Project>('update_project_metadata', {
        projectId: project.id,
        description: descriptionText || null,
        favorite: null,
        archived: null,
      });
      updateProject(updatedProject);
      setIsEditingDescription(false);
      toast.success('Description saved', { duration: 2000 });
    } catch (error: any) {
      toast.error(`Failed to save description: ${error}`);
    }
  };

  const handleCancelDescription = () => {
    setDescriptionText(project.description || '');
    setIsEditingDescription(false);
  };

  const handleOpenInEditor = async () => {
    if (!project.localPath) {
      toast.error('No local path configured');
      return;
    }

    const editorConfig = settings.ui.editor;
    const editorName = editorConfig.preset === 'custom'
      ? 'editor'
      : editorConfig.preset.charAt(0).toUpperCase() + editorConfig.preset.slice(1);

    try {
      await invoke('open_in_editor', {
        path: project.localPath,
        editorPreset: editorConfig.preset,
        customCommand: editorConfig.customCommand || null,
      });
      toast.success(`Opening in ${editorName}...`);
    } catch (error: any) {
      toast.error(`Failed to open ${editorName}: ${error}`);
    }
  };

  const handleCloneToLocal = async () => {
    if (!project.githubUrl) {
      toast.error('No GitHub URL configured');
      return;
    }

    try {
      // Open directory picker for clone destination
      const selectedPath = await open({
        directory: true,
        multiple: false,
        title: 'Select directory to clone repository into',
      });

      if (!selectedPath || typeof selectedPath !== 'string') {
        return; // User cancelled
      }

      setIsLoading(true);
      toast.loading('Cloning repository...', { id: 'clone' });

      // Clone repository - Tauri automatically converts camelCase to snake_case
      await invoke<Project>('clone_repository', {
        githubUrl: project.githubUrl,
        localPath: joinPath(selectedPath, project.name),
        projectId: project.id,
      });

      toast.success('Repository cloned successfully!', { id: 'clone' });

      // Refresh project in store
      await useAppStore.getState().refreshProject(project.id);
    } catch (error: any) {
      toast.error(`Failed to clone: ${error}`, { id: 'clone' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateGitHubRepoClick = async () => {
    if (!project.localPath) {
      toast.error('No local path configured');
      return;
    }

    // Check for GitHub token before opening modal
    try {
      const credentials = await invoke<{ username: string; hasToken: boolean }>('get_stored_github_credentials');

      if (!credentials || !credentials.username) {
        toast.error('GitHub credentials not found. Please configure your GitHub token in Settings.');
        return;
      }

      // Actually try to retrieve the token (will throw if not found)
      try {
        await invoke<string>('get_github_token', { username: credentials.username });
      } catch (tokenError) {
        toast.error('GitHub token not found. Please configure in Settings.');
        return;
      }

      // Token is valid, show the modal
      setShowCreateRepoModal(true);
    } catch (error: any) {
      toast.error('Failed to verify GitHub credentials');
    }
  };

  const handleCreateGitHubRepo = async (isPrivate: boolean) => {
    setShowCreateRepoModal(false);

    try {
      // Get GitHub token
      const credentials = await invoke<{ username: string; hasToken: boolean }>('get_stored_github_credentials');
      const token = await invoke<string>('get_github_token', { username: credentials.username });

      setIsLoading(true);
      toast.loading('Creating GitHub repository...', { id: 'create-repo' });

      // Create GitHub repository - Tauri automatically converts camelCase to snake_case
      await invoke<Project>('create_github_repository', {
        projectId: project.id,
        repoName: project.name,
        isPrivate: isPrivate,
        token: token,
      });

      const visibility = isPrivate ? 'private' : 'public';
      toast.success(`Created a ${visibility} GitHub repository. Choose files to publish when ready.`, { id: 'create-repo' });

      // Refresh project in store
      await useAppStore.getState().refreshProject(project.id);
    } catch (error: any) {
      const errorMsg = String(error);

      // Check if repository already exists on GitHub
      if (errorMsg.includes('name already exists on this account')) {
        toast.error(
          `Repository "${project.name}" already exists on GitHub.\n\nOptions:\n1. Delete it from GitHub and try again\n2. Use "Link Existing GitHub" to connect to the existing repo`,
          { id: 'create-repo', duration: 8000 }
        );
      } else {
        toast.error(`Failed to create repository: ${error}`, { id: 'create-repo' });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleLinkLocal = async (localPath: string) => {
    toast.loading('Linking local directory...', { id: 'link-local' });
    try {
      // Update project with local path
      const updatedProject: Project = {
        ...project,
        localPath: localPath,
        projectStatus: project.githubUrl ? 'ready' : 'local_only',
      };

      await updateProject(updatedProject);
      toast.success('Local directory linked successfully!', { id: 'link-local' });

      // Refresh to update status
      await refreshProject(project.id);
    } catch (error: any) {
      toast.error(`Failed to link local directory: ${error}`, { id: 'link-local' });
      throw error;
    }
  };

  const handleLinkGitHub = async (githubUrl: string, owner: string, repo: string) => {
    toast.loading('Linking GitHub repository...', { id: 'link-github' });
    try {
      // Update project with GitHub info
      const updatedProject: Project = {
        ...project,
        githubUrl: githubUrl,
        githubOwner: owner,
        githubRepo: repo,
        projectStatus: project.localPath ? 'ready' : 'github_only',
      };

      await updateProject(updatedProject);
      toast.success('GitHub repository linked successfully!', { id: 'link-github' });

      // Refresh to update status
      await refreshProject(project.id);
    } catch (error: any) {
      toast.error(`Failed to link GitHub repository: ${error}`, { id: 'link-github' });
      throw error;
    }
  };

  // Badge colour and icon follow what the last check could actually confirm (see getCardStatus).
  const TONE_BORDER: Record<CardTone, string> = {
    synced: 'border-green-500',
    unconfirmed: 'border-gray-400',
    changes: 'border-yellow-500',
    behind: 'border-orange-500',
    diverged: 'border-red-500',
    unavailable: 'border-red-400',
    not_git: 'border-gray-400',
    ready: 'border-blue-500',
    github_only: 'border-purple-500',
    local_only: 'border-indigo-500',
    not_configured: 'border-gray-300',
  };

  const getStatusIcon = () => {
    switch (cardStatus.tone) {
      case 'synced':
        return <CheckCircle className="w-5 h-5 text-green-600" aria-hidden="true" />;
      case 'changes':
      case 'behind':
      case 'diverged':
        return <AlertCircle className="w-5 h-5 text-yellow-600" aria-hidden="true" />;
      case 'unavailable':
        return <AlertCircle className="w-5 h-5 text-red-500" aria-hidden="true" />;
      case 'ready':
        return <Clock className="w-5 h-5 text-blue-600" aria-hidden="true" />;
      case 'github_only':
        return <Github className="w-5 h-5 text-purple-600" aria-hidden="true" />;
      case 'local_only':
        return <FolderGit className="w-5 h-5 text-indigo-600" aria-hidden="true" />;
      default:
        return <Clock className="w-5 h-5 text-gray-400" aria-hidden="true" />;
    }
  };

  // Render different action buttons based on project status
  const renderActions = () => {
    switch (project.projectStatus) {
      case 'not_configured':
        return (
          <div className="flex gap-2">
            <button
              onClick={() => setShowLinkGitHubModal(true)}
              className="flex items-center gap-2 px-4 py-2 text-white bg-purple-600 dark:bg-purple-700 rounded-lg hover:bg-purple-700 dark:hover:bg-purple-600 transition-colors"
              title="Link to GitHub repository"
            >
              <Github className="w-4 h-4" />
              Link GitHub
            </button>
            <button
              onClick={() => setShowLinkLocalModal(true)}
              className="flex items-center gap-2 px-4 py-2 text-white bg-indigo-600 dark:bg-indigo-700 rounded-lg hover:bg-indigo-700 dark:hover:bg-indigo-600 transition-colors"
              title="Link to local directory"
            >
              <FolderGit className="w-4 h-4" />
              Link Local
            </button>
          </div>
        );

      case 'github_only':
        return (
          <div className="flex gap-2">
            <button
              onClick={handleCloneToLocal}
              disabled={isLoading}
              className="flex items-center gap-2 px-4 py-2 text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Clone repository to local directory"
            >
              {isLoading ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              Clone to Local
            </button>
            <button
              onClick={() => setShowLinkLocalModal(true)}
              className="flex items-center gap-2 px-4 py-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              title="Link to existing local directory"
            >
              <LinkIcon className="w-4 h-4" />
              Link Existing Local
            </button>
          </div>
        );

      case 'local_only':
        return (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={handleCreateGitHubRepoClick}
              disabled={isLoading}
              className="flex items-center gap-2 px-4 py-2 text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Create GitHub repository and push"
            >
              {isLoading ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              Create GitHub Repo
            </button>
            <button
              onClick={() => setShowLinkGitHubModal(true)}
              className="flex items-center gap-2 px-4 py-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              title="Link to existing GitHub repository"
            >
              <LinkIcon className="w-4 h-4" />
              Link Existing GitHub
            </button>

            {canShowDetails && (
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="flex items-center gap-2 px-4 py-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                title="Show branches, commits, changes, stashes and tags"
              >
                {showDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                Details
              </button>
            )}
          </div>
        );

      case 'ready':
      case 'synced':
      case 'needs_push':
      case 'needs_merge':
      case 'needs_sync':
        // Show Git sync actions
        const hasLocalChanges = project.gitStatus && (project.gitStatus.uncommittedFiles > 0 || project.gitStatus.unpushedCommits > 0);
        const hasRemoteBranches = project.gitStatus && project.gitStatus.remoteBranches.length > 0;
        // Unknown state (never checked, or not a Git folder) is not a reason to hide the actions,
        // but a folder that is known not to be Git has nothing to publish.
        const notGit = project.gitStatus?.isGitRepo === false;

        return (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => void startPublish('push_local')}
              disabled={notGit || (project.gitStatus !== null && !hasLocalChanges) || isBusy}
              className="flex items-center gap-2 px-4 py-2 text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Choose changed files to commit, or push commits you already made"
            >
              {isBusy ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              Push Local
            </button>

            <button
              onClick={() => setIntegrationMode('pull_branches')}
              disabled={notGit || !hasRemoteBranches || isBusy}
              className="flex items-center gap-2 px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Bring in branches you choose from GitHub; the branches are kept"
            >
              <Download className="w-4 h-4" />
              Pull Updates
            </button>

            <button
              onClick={() => setIntegrationMode('merge_branches')}
              disabled={notGit || !hasRemoteBranches || isBusy}
              className="flex items-center gap-2 px-4 py-2 text-white bg-orange-600 rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Merge branches you choose into the current branch; the branches are kept"
            >
              <GitMerge className="w-4 h-4" />
              Merge Branches
            </button>

            <button
              onClick={() => void startPublish('full_sync')}
              disabled={notGit || isBusy}
              className="flex items-center gap-2 px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Sync the current branch with its GitHub branch. Other branches are not touched."
            >
              <RefreshCw className="w-4 h-4" />
              Sync Branch
            </button>

            <button
              onClick={handleOpenInEditor}
              className="flex items-center gap-2 px-4 py-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              title={`Open in ${settings.ui.editor.preset === 'custom' ? 'Editor' : settings.ui.editor.preset.charAt(0).toUpperCase() + settings.ui.editor.preset.slice(1)}`}
            >
              <Code className="w-4 h-4" />
            </button>

            {canShowDetails && (
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="flex items-center gap-2 px-4 py-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                title="Show advanced Git features"
              >
                {showDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                Details
              </button>
            )}

            <button
              onClick={handleToggleArchive}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                isArchived
                  ? 'text-orange-700 dark:text-orange-300 bg-orange-50 dark:bg-orange-900/20 border border-orange-300 dark:border-orange-700'
                  : 'text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
              title={isArchived ? 'Restore from archive' : 'Archive project'}
            >
              <Archive className="w-4 h-4" />
              {isArchived ? 'Restore' : 'Archive'}
            </button>
          </div>
        );

      default:
        return null;
    }
  };

  // Same actions as the text row, reached from one menu so the compact card stays short.
  const simpleMenuItems = (): CardMenuItem[] => {
    const items: CardMenuItem[] = [];
    const archive = () =>
      items.push({
        id: 'archive',
        label: isArchived ? 'Restore' : 'Archive',
        onClick: () => void handleToggleArchive(),
      });
    const details = () => {
      if (!canShowDetails) return;
      items.push({
        id: 'details',
        label: showDetails ? 'Hide Details' : 'Details',
        onClick: () => setShowDetails(!showDetails),
      });
    };

    switch (project.projectStatus) {
      case 'not_configured':
        items.push(
          { id: 'link-github', label: 'Link GitHub', onClick: () => setShowLinkGitHubModal(true) },
          { id: 'link-local', label: 'Link Local', onClick: () => setShowLinkLocalModal(true) },
        );
        archive();
        break;
      case 'github_only':
        items.push(
          { id: 'clone', label: 'Clone to Local', onClick: () => void handleCloneToLocal(), disabled: isLoading },
          { id: 'link-local', label: 'Link Existing Local', onClick: () => setShowLinkLocalModal(true) },
        );
        archive();
        break;
      case 'local_only':
        items.push(
          { id: 'create-github', label: 'Create GitHub Repo', onClick: () => void handleCreateGitHubRepoClick(), disabled: isLoading },
          { id: 'link-github', label: 'Link Existing GitHub', onClick: () => setShowLinkGitHubModal(true) },
        );
        details();
        archive();
        break;
      default: {
        const hasLocalChanges = project.gitStatus && (project.gitStatus.uncommittedFiles > 0 || project.gitStatus.unpushedCommits > 0);
        const hasRemoteBranches = project.gitStatus && project.gitStatus.remoteBranches.length > 0;
        const notGit = project.gitStatus?.isGitRepo === false;
        const editorName = settings.ui.editor.preset === 'custom'
          ? 'Editor'
          : settings.ui.editor.preset.charAt(0).toUpperCase() + settings.ui.editor.preset.slice(1);
        items.push(
          {
            id: 'push',
            label: 'Push Local',
            onClick: () => void startPublish('push_local'),
            disabled: notGit || (project.gitStatus !== null && !hasLocalChanges) || isBusy,
          },
          {
            id: 'pull',
            label: 'Pull Updates',
            onClick: () => setIntegrationMode('pull_branches'),
            disabled: notGit || !hasRemoteBranches || isBusy,
          },
          {
            id: 'merge',
            label: 'Merge Branches',
            onClick: () => setIntegrationMode('merge_branches'),
            disabled: notGit || !hasRemoteBranches || isBusy,
          },
          {
            id: 'sync',
            label: 'Sync Branch',
            onClick: () => void startPublish('full_sync'),
            disabled: notGit || isBusy,
          },
          { id: 'editor', label: `Open in ${editorName}`, onClick: () => void handleOpenInEditor() },
        );
        details();
        archive();
      }
    }
    return items;
  };

  const overlays = (
    <>
      {showRecovery && project.localPath && <RecoveryWorkspace project={project} onClose={() => setShowRecovery(false)} />}
      <LinkLocalModal
        isOpen={showLinkLocalModal}
        onClose={() => setShowLinkLocalModal(false)}
        onLink={handleLinkLocal}
        projectName={project.name}
      />
      <LinkGitHubModal
        isOpen={showLinkGitHubModal}
        onClose={() => setShowLinkGitHubModal(false)}
        onLink={handleLinkGitHub}
        projectName={project.name}
      />
      <CreateRepoModal
        isOpen={showCreateRepoModal}
        onClose={() => setShowCreateRepoModal(false)}
        onCreate={handleCreateGitHubRepo}
        projectName={project.name}
      />
      {project.localPath && (
        <CommitModal
          isOpen={commitKind !== null}
          onClose={() => setCommitKind(null)}
          onSubmit={handleModalSubmit}
          repoPath={project.localPath}
          projectName={project.name}
          mode={commitKind ?? 'push_local'}
          isLoading={isCommitting}
          submitError={submitError}
          reloadSignal={reloadSignal}
        />
      )}
      {pending && (
        <ValidationWarningModal
          isOpen
          onClose={() => setPending(null)}
          onProceed={handleProceedWithWarnings}
          onGitignoreUpdated={handleGitignoreUpdated}
          validation={pending.validation}
          projectId={project.id}
          isBusy={isCommitting}
        />
      )}
      <BranchIntegrationModal
        isOpen={integrationMode !== null}
        mode={integrationMode ?? 'merge_branches'}
        projectName={project.name}
        currentBranch={project.gitStatus?.currentBranch}
        branches={project.gitStatus?.remoteBranches ?? []}
        checkedAt={project.gitStatus?.remoteCheckedAt}
        isLoading={isCommitting}
        onConfirm={handleIntegrate}
        onClose={() => setIntegrationMode(null)}
      />
    </>
  );

  if (density === 'simple') {
    const identity = project.localPath
      ?? (project.githubOwner && project.githubRepo ? `${project.githubOwner}/${project.githubRepo}` : null);
    const menuItems = simpleMenuItems();

    return (
      <div
        ref={cardRef}
        data-testid="project-card"
        data-project={project.name}
        data-density="simple"
        className={`min-w-0 bg-white dark:bg-gray-800 rounded-lg shadow-sm border-l-4 ${TONE_BORDER[cardStatus.tone]} p-3 transition-all hover:shadow-md dark:hover:shadow-lg`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 min-w-0">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggleSelection(project.id)}
              className="mt-1 w-4 h-4 text-teal-600 rounded focus:ring-2 focus:ring-teal-500"
            />
            <div className="flex min-w-0 items-center gap-2">
              <span className="inline-flex shrink-0">{getStatusIcon()}</span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <h3
                    className="font-semibold text-gray-900 dark:text-white truncate"
                    title={project.description || project.name}
                  >
                    {project.name}
                  </h3>
                  {isArchived && <Archive className="w-4 h-4 flex-shrink-0 text-gray-400 dark:text-gray-500" />}
                </div>
                <StatusLabel project={project} cardStatus={cardStatus} compact />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <IconTip tip={isFavorite ? 'Remove from favorites' : 'Add to favorites'}>
              <button
                onClick={handleToggleFavorite}
                aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                className={`p-1.5 rounded-lg transition-colors ${
                  isFavorite
                    ? 'text-yellow-500 hover:text-yellow-600 bg-yellow-50 dark:bg-yellow-900/20'
                    : 'text-gray-400 dark:text-gray-500 hover:text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-900/20'
                }`}
              >
                <Star className={`w-4 h-4 ${isFavorite ? 'fill-current' : ''}`} />
              </button>
            </IconTip>
            {project.localPath && (
              <IconTip tip="Save versions of this project and recover files">
                <button
                  onClick={() => setShowRecovery(true)}
                  className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-teal-600 dark:hover:text-teal-400 hover:bg-teal-50 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  aria-label="Save & Recover"
                >
                  <HistoryIcon className="w-4 h-4" />
                </button>
              </IconTip>
            )}
            {project.localPath && (
              <IconTip tip="Refresh this project's Git status">
                <button
                  onClick={handleRefreshStatus}
                  disabled={isRefreshing || syncingProjects.has(project.id)}
                  aria-label="Refresh status"
                  className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-teal-600 dark:hover:text-teal-400 hover:bg-teal-50 dark:hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50"
                >
                  <RotateCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                </button>
              </IconTip>
            )}
            <div className="relative" ref={menuRef}>
              {!menuOpen && (
                <IconTip tip="More actions">
                  <button
                    onClick={() => setMenuOpen(true)}
                    aria-label="More actions"
                    aria-expanded={false}
                    className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                </IconTip>
              )}
              {menuOpen && (
                <button
                  onClick={() => setMenuOpen(false)}
                  aria-label="More actions"
                  aria-expanded
                  className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                >
                  <MoreHorizontal className="w-4 h-4" />
                </button>
              )}
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-20 mt-1 w-52 max-w-[70vw] rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg py-1"
                >
                  {menuItems.map((item) => (
                    <button
                      key={item.id}
                      role="menuitem"
                      disabled={item.disabled}
                      onClick={() => {
                        setMenuOpen(false);
                        item.onClick();
                      }}
                      className="block w-full px-3 py-1.5 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <IconTip tip="Delete this project from BitGit">
              <button
                onClick={handleDelete}
                aria-label="Delete project"
                className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 rounded-lg transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </IconTip>
          </div>
        </div>

        <div className="mt-2 space-y-2 min-w-0">
          <ProjectLabels project={project} catalog={labelCatalog} compact />
          {identity && (
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate" title={identity}>{identity}</p>
          )}
          <CompactSync project={project} />
        </div>

        {notice && (
          <div
            className={`mt-2 flex items-start justify-between gap-2 rounded-lg border p-2 text-xs ${NOTICE_STYLE[notice.tone]}`}
            role={notice.tone === 'error' ? 'alert' : 'status'}
            data-testid="card-notice"
            data-tone={notice.tone}
          >
            <p className="min-w-0 break-words">{notice.title}</p>
            <button onClick={() => setNotice(null)} aria-label="Dismiss message" className="flex-shrink-0 opacity-70 hover:opacity-100">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {showDetails && canShowDetails && (
          <ProjectDetails project={project} onClose={() => setShowDetails(false)} />
        )}
        {overlays}
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      data-testid="project-card"
      data-project={project.name}
      data-density="detail"
      className={`bg-white dark:bg-gray-800 rounded-lg shadow-sm border-l-4 ${TONE_BORDER[cardStatus.tone]} p-6 transition-all hover:shadow-md dark:hover:shadow-lg`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => toggleSelection(project.id)}
            className="w-4 h-4 text-teal-600 rounded focus:ring-2 focus:ring-teal-500"
          />
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex shrink-0">{getStatusIcon()}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-lg text-gray-900 dark:text-white truncate">{project.name}</h3>
                {isArchived && <Archive className="w-4 h-4 shrink-0 text-gray-400 dark:text-gray-500" />}
              </div>
              <StatusLabel project={project} cardStatus={cardStatus} />
            </div>
          </div>
          <IconTip tip={isFavorite ? 'Remove from favorites' : 'Add to favorites'} align="center">
            <button
              onClick={handleToggleFavorite}
              aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              className={`p-1.5 rounded-lg transition-colors ${
                isFavorite
                  ? 'text-yellow-500 hover:text-yellow-600 bg-yellow-50 dark:bg-yellow-900/20'
                  : 'text-gray-400 dark:text-gray-500 hover:text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-900/20'
              }`}
            >
              <Star className={`w-4 h-4 ${isFavorite ? 'fill-current' : ''}`} />
            </button>
          </IconTip>

          {/* Save & Recover - available for every project with a local folder */}
          {project.localPath && (
            <button
              onClick={() => setShowRecovery(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-gray-600 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg hover:text-teal-700 dark:hover:text-teal-300 hover:bg-teal-50 dark:hover:bg-gray-700 transition-colors"
              title="Save versions of this project, compare them and recover files"
            >
              <HistoryIcon className="w-4 h-4" />
              Save &amp; Recover
            </button>
          )}

          {/* Refresh - any project with a local folder, GitHub link or not */}
          {project.localPath && (
            <IconTip tip="Refresh this project's Git status" align="center">
              <button
                onClick={handleRefreshStatus}
                disabled={isRefreshing || syncingProjects.has(project.id)}
                aria-label="Refresh status"
                className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-teal-600 dark:hover:text-teal-400 hover:bg-teal-50 dark:hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50"
              >
                <RotateCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              </button>
            </IconTip>
          )}
        </div>
        <IconTip tip="Delete this project from BitGit">
          <button
            onClick={handleDelete}
            aria-label="Delete project"
            className="text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 transition-colors"
          >
            <Trash2 className="w-5 h-5" />
          </button>
        </IconTip>
      </div>

      {/* Description Section */}
      {(project.description || isEditingDescription) && (
        <div className="mb-4">
          {isEditingDescription ? (
            <div className="space-y-2">
              <textarea
                value={descriptionText}
                onChange={(e) => setDescriptionText(e.target.value)}
                placeholder="Add a description for this project..."
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm resize-none"
                rows={3}
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSaveDescription}
                  className="flex items-center gap-1 px-3 py-1 text-sm bg-teal-600 dark:bg-teal-700 text-white rounded-lg hover:bg-teal-700 dark:hover:bg-teal-800 transition-colors"
                >
                  <Save className="w-3 h-3" />
                  Save
                </button>
                <button
                  onClick={handleCancelDescription}
                  className="flex items-center gap-1 px-3 py-1 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                >
                  <X className="w-3 h-3" />
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 p-3 rounded-lg">
              <p className="flex-1">{project.description}</p>
              <button
                onClick={() => setIsEditingDescription(true)}
                className="p-1 text-gray-400 hover:text-teal-600 dark:hover:text-teal-400 transition-colors"
                title="Edit description"
              >
                <Edit2 className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Add Description Button */}
      {!project.description && !isEditingDescription && (
        <button
          onClick={() => setIsEditingDescription(true)}
          className="mb-4 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-teal-600 dark:hover:text-teal-400 transition-colors"
        >
          <Edit2 className="w-4 h-4" />
          Add description
        </button>
      )}

      <ProjectLabels project={project} catalog={labelCatalog} />

      {/* Project Info */}
      <div className="space-y-2 mb-4 text-sm">
        {project.githubUrl && (
          <div className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
            <Github className="w-4 h-4" />
            <span className="font-medium">GitHub:</span>
            <span className="text-gray-600 dark:text-gray-400">{project.githubOwner}/{project.githubRepo}</span>
            <a
              href={project.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 text-teal-600 dark:text-teal-400 hover:text-teal-700 dark:hover:text-teal-300 transition-colors"
              title="Open on GitHub"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        )}
        {project.localPath && (
          <div className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
            <FolderGit className="w-4 h-4" />
            <span className="font-medium">Local:</span>
            <span className="text-gray-600 dark:text-gray-400 truncate">{project.localPath}</span>
          </div>
        )}

        {/* Last synced timestamp */}
        {project.lastSynced && (
          <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
            <Clock className="w-4 h-4" />
            <span className="font-medium">Last synced:</span>
            <span>{formatRelativeTime(project.lastSynced)}</span>
          </div>
        )}

        {/* Branch, upstream, ahead/behind and how fresh the GitHub reading is */}
        <GitStatusSummary project={project} />
        {project.gitStatus && project.gitStatus.remoteBranches.length > 0 && (
          <div className="flex items-center gap-2 text-orange-700 dark:text-orange-400">
            <GitBranch className="w-4 h-4" aria-hidden="true" />
            <span>
              {project.gitStatus.remoteBranches.length} other branch(es) on GitHub:{' '}
              {project.gitStatus.remoteBranches.join(', ')}
            </span>
          </div>
        )}
      </div>

      {/* What just happened, kept until the next action */}
      {notice && (
        <div
          className={`mb-4 flex items-start justify-between gap-3 rounded-lg border p-3 text-sm ${NOTICE_STYLE[notice.tone]}`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
          data-testid="card-notice"
          data-tone={notice.tone}
        >
          <div className="min-w-0">
            <p className="font-medium">{notice.title}</p>
            {notice.detail && <p className="break-words">{notice.detail}</p>}
          </div>
          <button onClick={() => setNotice(null)} aria-label="Dismiss message" className="flex-shrink-0 opacity-70 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Actions */}
      {renderActions()}

      {/* Expandable Details Panel */}
      {showDetails && canShowDetails && (
        <ProjectDetails project={project} onClose={() => setShowDetails(false)} />
      )}

      {overlays}
    </div>
  );
}

// Export as RepositoryCard for backward compatibility
export { ProjectCard as RepositoryCard };
