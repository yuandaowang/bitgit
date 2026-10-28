import type { Project } from '../../types';

// A "Synced" claim needs a recent successful read of the remote. Older than this it is shown as unconfirmed.
export const STATUS_STALE_MS = 30 * 60 * 1000;

export function formatRelativeTime(dateString: string, now: number = Date.now()): string {
  const date = new Date(dateString);
  const diffSeconds = Math.floor((now - date.getTime()) / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  return date.toLocaleDateString();
}

export type CardTone =
  | 'synced'
  | 'unconfirmed'
  | 'changes'
  | 'behind'
  | 'diverged'
  | 'unavailable'
  | 'not_git'
  | 'ready'
  | 'github_only'
  | 'local_only'
  | 'not_configured';

export interface CardStatus {
  tone: CardTone;
  text: string;
}

export function isRemoteCheckStale(remoteCheckedAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!remoteCheckedAt) return true;
  const checked = new Date(remoteCheckedAt).getTime();
  return Number.isNaN(checked) || now - checked > STATUS_STALE_MS;
}

export interface RemoteTarget {
  href: string;
  label: string;
}

// Turns a Git remote URL into a page the browser can open. Local paths and unknown schemes stay closed.
export function remoteTarget(raw: string | null | undefined): RemoteTarget | null {
  if (!raw?.trim()) return null;
  let href = raw.trim().replace(/\.git$/, '');
  const scp = href.match(/^git@([^:]+):(.+)$/);
  if (scp) href = `https://${scp[1]}/${scp[2]}`;
  else {
    const ssh = href.match(/^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
    if (ssh) href = `https://${ssh[1]}/${ssh[2]}`;
  }
  if (!/^https?:\/\//i.test(href)) return null;
  try {
    const url = new URL(href);
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    return { href, label: path ? `${url.host}/${path}` : url.host };
  } catch {
    return null;
  }
}

// What the card badge says. Anything the last check could not confirm is never shown as Synced.
export function getCardStatus(project: Project, now: number = Date.now()): CardStatus {
  if (project.projectStatus === 'not_configured') return { tone: 'not_configured', text: 'Not Configured' };
  if (!project.localPath) return { tone: 'github_only', text: 'GitHub Only' };

  const git = project.gitStatus;
  if (git && git.isGitRepo === false) return { tone: 'not_git', text: 'Git unavailable' };

  const linked = Boolean(project.githubUrl);
  if (!linked) return { tone: 'local_only', text: 'Local Only' };
  if (!git) return { tone: 'ready', text: 'Not checked yet' };

  switch (git.syncStatus) {
    case 'unavailable':
      return { tone: 'unavailable', text: 'Status unavailable' };
    case 'diverged':
      return { tone: 'diverged', text: 'Diverged from GitHub' };
    case 'behind':
      return { tone: 'behind', text: 'Behind GitHub' };
    case 'both':
      return { tone: 'diverged', text: 'Changes here, updates on GitHub' };
    case 'local_changes':
      return { tone: 'changes', text: 'Changes to publish' };
    case 'remote_branches':
      return { tone: 'behind', text: 'Other branches on GitHub' };
    case 'not_connected':
      return { tone: 'ready', text: 'Not connected to a GitHub branch' };
    case 'synced':
      return isRemoteCheckStale(git.remoteCheckedAt, now)
        ? { tone: 'unconfirmed', text: 'Not confirmed recently' }
        : { tone: 'synced', text: 'Synced' };
    default:
      return { tone: 'ready', text: 'Unknown' };
  }
}
