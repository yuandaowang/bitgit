import { GitBranch, GitCommit, AlertTriangle, Clock, FolderX } from 'lucide-react';
import type { Project } from '../../types';
import { formatRelativeTime, isRemoteCheckStale } from './gitStatusView';

// Branch, upstream, ahead/behind and how fresh the remote reading is. Read-only: it shows the
// last stored check and never triggers Git itself.
export function GitStatusSummary({ project }: { project: Project }) {
  const git = project.gitStatus;
  if (!project.localPath) return null;

  if (!git) {
    return (
      <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400" data-testid="git-status-summary">
        <Clock className="w-4 h-4" aria-hidden="true" />
        <span>Git status has not been checked yet. Use Refresh to check.</span>
      </div>
    );
  }

  if (!git.isGitRepo) {
    return (
      <div className="flex items-start gap-2 text-gray-600 dark:text-gray-400" data-testid="git-status-summary">
        <FolderX className="w-4 h-4 mt-0.5" aria-hidden="true" />
        <span>
          Git unavailable: this folder is not a Git repository. BitGit will not turn it into one
          on its own. Save &amp; Recover still works.
        </span>
      </div>
    );
  }

  const ahead = git.unpushedCommits;
  const behind = git.behindCommits ?? 0;
  const failed = Boolean(git.remoteError);
  const checkedStale = git.hasRemote && !failed && isRemoteCheckStale(git.remoteCheckedAt);

  return (
    <div className="space-y-1" data-testid="git-status-summary">
      <div className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
        <GitBranch className="w-4 h-4" aria-hidden="true" />
        {git.currentBranch ? (
          <span>
            Branch <span className="font-mono">{git.currentBranch}</span>
            {git.upstream ? (
              <>
                {' '}tracks <span className="font-mono">{git.upstream}</span>
              </>
            ) : git.hasRemote ? (
              ' has no remote branch to track yet'
            ) : (
              ' (no Git remote)'
            )}
          </span>
        ) : (
          <span>Not on a branch (detached HEAD)</span>
        )}
      </div>

      {git.upstream && (
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
          <GitCommit className="w-4 h-4" aria-hidden="true" />
          <span>
            {ahead} ahead, {behind} behind
            {failed || checkedStale ? ' (last known counts)' : ''}
          </span>
        </div>
      )}

      {git.syncStatus === 'diverged' && (
        <p className="text-yellow-700 dark:text-yellow-400 pl-6">
          Your computer and the remote each have commits the other lacks. BitGit will not overwrite
          either side, so combine them outside BitGit first.
        </p>
      )}
      {git.syncStatus === 'behind' && (
        <p className="text-gray-600 dark:text-gray-400 pl-6">
          The remote has new commits for this branch. Sync Branch brings them in.
        </p>
      )}
      {git.syncStatus === 'both' && (
        <p className="text-yellow-700 dark:text-yellow-400 pl-6">
          The remote has new commits and this folder has uncommitted changes. Sync Branch refuses to
          continue until those changes are dealt with; nothing is changed.
        </p>
      )}

      {git.uncommittedFiles > 0 && (
        <div className="flex items-center gap-2 text-yellow-700 dark:text-yellow-400">
          <GitCommit className="w-4 h-4" aria-hidden="true" />
          <span>
            {git.uncommittedFiles} file(s) with uncommitted changes
            {git.untrackedFiles > 0 ? `, ${git.untrackedFiles} not tracked yet` : ''}
          </span>
        </div>
      )}

      {failed ? (
        <div className="flex items-start gap-2 text-red-700 dark:text-red-400" role="alert">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>
            Could not read the remote: {git.remoteError}
            {git.remoteCheckedAt ? ` Last successful check ${formatRelativeTime(git.remoteCheckedAt)}.` : ''}
          </span>
        </div>
      ) : git.hasRemote ? (
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <Clock className="w-4 h-4" aria-hidden="true" />
          <span>
            {git.remoteCheckedAt
              ? `Remote last read ${formatRelativeTime(git.remoteCheckedAt)}${checkedStale ? '. Refresh to confirm.' : ''}`
              : 'The remote has not been read yet.'}
          </span>
        </div>
      ) : null}
    </div>
  );
}
