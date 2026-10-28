import { useEffect, useRef, useState } from 'react';
import { X, GitMerge, GitBranch, Info } from 'lucide-react';
import { formatRelativeTime } from './gitStatusView';

interface BranchIntegrationModalProps {
  isOpen: boolean;
  mode: 'merge_branches' | 'pull_branches';
  projectName: string;
  currentBranch: string | null | undefined;
  // Branches that exist on GitHub besides the current one, as of the last status check.
  branches: string[];
  checkedAt?: string | null;
  isLoading?: boolean;
  // Receives exactly the branch names the user ticked, in list order.
  onConfirm: (branches: string[]) => void;
  onClose: () => void;
}

// No branch is chosen for the user, and the confirmation names every branch that will be used.
export function BranchIntegrationModal({
  isOpen,
  mode,
  projectName,
  currentBranch,
  branches,
  checkedAt,
  isLoading = false,
  onConfirm,
  onClose,
}: BranchIntegrationModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setSelected(new Set());
      dialogRef.current?.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const chosen = branches.filter((b) => selected.has(b));
  const noun = mode === 'merge_branches' ? 'Merge' : 'Pull';
  const target = currentBranch ? <span className="font-mono">{currentBranch}</span> : 'your current branch';
  const canConfirm = chosen.length > 0 && !isLoading && Boolean(currentBranch);

  const toggle = (branch: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(branch)) next.delete(branch);
      else next.add(branch);
      return next;
    });

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="branch-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !isLoading) onClose();
        }}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col outline-none"
      >
        <div className="flex items-center justify-between p-4 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <div className="flex items-center gap-3">
            <GitMerge className="w-5 h-5 text-orange-600 dark:text-orange-400" aria-hidden="true" />
            <div>
              <h2 id="branch-title" className="text-lg font-semibold text-gray-900 dark:text-white">
                {noun} Branches
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">{projectName}</p>
            </div>
          </div>
          <button onClick={onClose} disabled={isLoading} aria-label="Close" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Choose the branches to bring into {target}. Each one is merged with a merge commit,
            checked for problems and then published to the remote. Nothing is chosen for you.
          </p>

          {!currentBranch && (
            <p className="text-sm text-red-700 dark:text-red-400" role="alert">
              This project is not on a branch right now. Switch to a branch in Details first.
            </p>
          )}

          {branches.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 rounded-lg p-3">
              No other branches were found on the remote at the last check. Use Refresh to look again.
            </p>
          ) : (
            <ul className="space-y-2" aria-label="Branches on the remote">
              {branches.map((branch) => (
                <li key={branch}>
                  <label className="flex items-center gap-3 p-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700">
                    <input
                      type="checkbox"
                      checked={selected.has(branch)}
                      disabled={isLoading}
                      onChange={() => toggle(branch)}
                      className="w-4 h-4 text-orange-600 rounded focus:ring-2 focus:ring-orange-500"
                    />
                    <GitBranch className="w-4 h-4 text-gray-500 dark:text-gray-400" aria-hidden="true" />
                    <span className="font-mono text-sm text-gray-900 dark:text-white">{branch}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {checkedAt && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Branch list from the check {formatRelativeTime(checkedAt)}.
            </p>
          )}

          <div
            className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3"
            data-testid="branch-confirmation"
          >
            <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
            <p>
              {chosen.length === 0 ? (
                'No branches chosen yet.'
              ) : (
                <>
                  {noun === 'Merge' ? 'Merging' : 'Pulling'}{' '}
                  <span className="font-mono">{chosen.join(', ')}</span> into {target}.{' '}
                  {chosen.length === 1 ? 'That branch stays' : 'Those branches stay'} on the remote and on this computer.
                </>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 p-4 border-t dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <button
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(chosen)}
            disabled={!canConfirm}
            className="flex items-center gap-2 px-4 py-2 text-white bg-orange-600 rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <GitMerge className="w-4 h-4" aria-hidden="true" />
            {chosen.length === 0 ? `${noun} branches` : `${noun} ${chosen.length} branch${chosen.length !== 1 ? 'es' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
