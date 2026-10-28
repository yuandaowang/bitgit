import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { X, GitCommit, RefreshCw, AlertTriangle, Info } from 'lucide-react';
import type { FileChangeInfo } from '../types';
import { FileChangeRow, unselectableReason } from './git/FileChangeRow';

interface CommitModalProps {
  isOpen: boolean;
  onClose: () => void;
  // Receives exactly the whole files the user chose; an empty list means "push existing commits only".
  onSubmit: (message: string, description: string | undefined, selectedFiles: string[]) => void;
  repoPath: string;
  projectName: string;
  mode: 'push_local' | 'full_sync';
  isLoading?: boolean;
  submitError?: string | null;
  // Bump to re-read the file list (for example after .gitignore changed). Chosen files that are
  // still pending stay chosen; files that appear are never chosen automatically.
  reloadSignal?: number;
}

const defaultMessage = () => {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return `Update ${dateStr} ${timeStr}`;
};

export function CommitModal({
  isOpen,
  onClose,
  onSubmit,
  repoPath,
  projectName,
  mode,
  isLoading = false,
  submitError = null,
  reloadSignal = 0,
}: CommitModalProps) {
  const [message, setMessage] = useState('');
  const [description, setDescription] = useState('');
  const [changes, setChanges] = useState<FileChangeInfo[] | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [generation, setGeneration] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const latestRead = useRef(0);
  const suggestedMessage = useRef('');

  const readChanges = useCallback(async () => {
    const id = ++latestRead.current;
    setIsReading(true);
    setReadError(null);
    try {
      const result = await invoke<FileChangeInfo[]>('git_get_file_changes', { repoPath });
      if (id !== latestRead.current) return;
      setChanges(result);
      setSelected((prev) => {
        const pending = new Set(result.filter((c) => !unselectableReason(c)).map((c) => c.path));
        return new Set([...prev].filter((path) => pending.has(path)));
      });
      setPreviewErrors(previous => Object.fromEntries(Object.entries(previous).filter(([path]) => result.some(change => change.path === path))));
      setGeneration((g) => g + 1);
    } catch (error: any) {
      if (id !== latestRead.current) return;
      setChanges(null);
      setReadError(String(error));
    } finally {
      if (id === latestRead.current) setIsReading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Every open starts from a fresh read and nothing chosen.
  useEffect(() => {
    if (!isOpen) return;
    suggestedMessage.current = defaultMessage();
    setMessage(suggestedMessage.current);
    setDescription('');
    setSelected(new Set());
    setPreviewErrors({});
    setChanges(null);
    void readChanges();
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => {
      clearTimeout(timer);
      latestRead.current++;
    };
  }, [isOpen, readChanges]);

  useEffect(() => {
    if (isOpen && reloadSignal > 0) void readChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal]);

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const setPreviewError = useCallback((path: string, error: string | null) => {
    setPreviewErrors((prev) => {
      if ((prev[path] ?? null) === error) return prev;
      const next = { ...prev };
      if (error) next[path] = error;
      else delete next[path];
      return next;
    });
  }, []);

  if (!isOpen) return null;

  const selectable = (changes ?? []).filter((c) => !unselectableReason(c));
  const chosen = (changes ?? []).filter((c) => selected.has(c.path)).map((c) => c.path);
  const blindFiles = chosen.filter((path) => previewErrors[path]);
  const hasPending = (changes?.length ?? 0) > 0;
  const busy = isLoading || isReading;

  let blocker: string | null = null;
  if (readError) blocker = 'Your changes could not be read, so nothing can be published.';
  else if (changes === null) blocker = 'Reading your changes...';
  else if (hasPending && chosen.length === 0) blocker = 'Choose at least one file to publish.';
  else if (blindFiles.length > 0) blocker = `The preview failed for ${blindFiles.join(', ')}. Try again or unselect it before publishing.`;
  const canSubmit = blocker === null && !busy;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(message.trim() || suggestedMessage.current, description.trim() || undefined, chosen);
  };

  const verb = mode === 'full_sync' ? 'Sync' : 'Push';
  const submitLabel = !hasPending
    ? `${verb} existing commits`
    : chosen.length === 0
      ? `Commit & ${verb}`
      : `Commit ${chosen.length} file${chosen.length !== 1 ? 's' : ''} & ${verb}`;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="commit-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !isLoading) onClose();
        }}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <div className="flex items-center gap-3">
            <GitCommit className="w-5 h-5 text-teal-600 dark:text-teal-400" aria-hidden="true" />
            <div>
              <h2 id="commit-title" className="text-lg font-semibold text-gray-900 dark:text-white">
                {mode === 'full_sync' ? 'Sync with remote' : 'Publish Changes'}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">{projectName}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isLoading}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-4">
          <div>
            <label htmlFor="commit-message" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Commit message <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              id="commit-message"
              ref={inputRef}
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Describe your changes..."
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg
                       bg-white dark:bg-gray-700 text-gray-900 dark:text-white
                       focus:ring-2 focus:ring-teal-500 focus:border-teal-500
                       placeholder-gray-400 dark:placeholder-gray-500"
              disabled={isLoading}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Left empty, the date and time above is used.
            </p>
          </div>

          <div>
            <label htmlFor="commit-description" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Description <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <textarea
              id="commit-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a longer description if needed..."
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg
                       bg-white dark:bg-gray-700 text-gray-900 dark:text-white
                       focus:ring-2 focus:ring-teal-500 focus:border-teal-500
                       placeholder-gray-400 dark:placeholder-gray-500 resize-none"
              disabled={isLoading}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Changed files
                {changes && changes.length > 0 && (
                  <span className="ml-2 font-normal text-gray-500 dark:text-gray-400">
                    {chosen.length} of {changes.length} chosen
                  </span>
                )}
              </h3>
              <div className="flex items-center gap-2 text-sm">
                {selectable.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setSelected(new Set(selectable.map((c) => c.path)))}
                      disabled={isLoading}
                      className="text-teal-700 dark:text-teal-300 hover:underline disabled:opacity-50"
                    >
                      Choose all
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelected(new Set())}
                      disabled={isLoading}
                      className="text-teal-700 dark:text-teal-300 hover:underline disabled:opacity-50"
                    >
                      Choose none
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => void readChanges()}
                  disabled={busy}
                  className="flex items-center gap-1 text-gray-600 dark:text-gray-400 hover:text-teal-700 dark:hover:text-teal-300 disabled:opacity-50"
                  title="Read the changed files again"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isReading ? 'animate-spin' : ''}`} aria-hidden="true" />
                  Reload
                </button>
              </div>
            </div>

            <div className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-400 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-2">
              <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
              <p>
                Nothing is chosen for you. You publish whole files: a chosen file is committed as it
                is on disk right now, including any part you had already staged. Staged files you
                do not choose stay staged and are not published. Publishing only part of a file's
                changes is not available.
              </p>
            </div>

            {isReading && changes === null && (
              <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400" role="status">
                <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
                Reading your changes...
              </div>
            )}

            {readError && (
              <div className="flex items-start gap-2 text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3" role="alert">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
                <div>
                  <p>Could not read your changes: {readError}</p>
                  <p>Nothing was published.</p>
                </div>
              </div>
            )}

            {changes && changes.length === 0 && (
              <p className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 rounded-lg p-3" data-testid="no-pending-files">
                There are no uncommitted changes. Publishing will only send commits you already made.
              </p>
            )}

            {changes && changes.length > 0 && (
              <ul className="space-y-2" aria-label="Changed files">
                {changes.map((change) => (
                  <FileChangeRow
                    key={`${generation}:${change.path}`}
                    repoPath={repoPath}
                    change={change}
                    checked={selected.has(change.path)}
                    disabled={isLoading}
                    onToggle={toggle}
                    onPreviewError={setPreviewError}
                    previousError={previewErrors[change.path]}
                  />
                ))}
              </ul>
            )}
          </div>

          {submitError && (
            <div className="flex items-start gap-2 text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3" role="alert">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
              <p>{submitError}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 p-4 border-t dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <p className="text-xs text-gray-600 dark:text-gray-400 min-w-0" data-testid="publish-blocker">
            {blocker && !isReading ? blocker : ''}
          </p>
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              onClick={onClose}
              disabled={isLoading}
              className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700
                       border border-gray-300 dark:border-gray-600 rounded-lg
                       hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors
                       disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!canSubmit}
              className="flex items-center gap-2 px-4 py-2 text-white bg-teal-600 rounded-lg
                       hover:bg-teal-700 transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Working...
                </>
              ) : (
                <>
                  <GitCommit className="w-4 h-4" aria-hidden="true" />
                  {submitLabel}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
