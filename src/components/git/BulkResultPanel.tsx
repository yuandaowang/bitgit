import { X, CheckCircle, MinusCircle, AlertTriangle, XCircle, SkipForward } from 'lucide-react';
import type { BulkOutcome, BulkProjectResult } from '../../types';

const OUTCOME_LABEL: Record<BulkOutcome, string> = {
  published: 'Published',
  up_to_date: 'Already up to date',
  needs_review: 'Needs your review',
  blocked: 'Blocked',
  failed: 'Failed',
  skipped: 'Skipped',
};

const OUTCOME_ICON: Record<BulkOutcome, JSX.Element> = {
  published: <CheckCircle className="w-4 h-4 text-green-600" aria-hidden="true" />,
  up_to_date: <MinusCircle className="w-4 h-4 text-gray-500" aria-hidden="true" />,
  needs_review: <AlertTriangle className="w-4 h-4 text-yellow-600" aria-hidden="true" />,
  blocked: <XCircle className="w-4 h-4 text-red-600" aria-hidden="true" />,
  failed: <XCircle className="w-4 h-4 text-red-600" aria-hidden="true" />,
  skipped: <SkipForward className="w-4 h-4 text-gray-500" aria-hidden="true" />,
};

interface BulkResultPanelProps {
  title: string;
  results: BulkProjectResult[];
  onReview: (projectId: string) => void;
  onDismiss: () => void;
}

// Per-project outcome of a batch. Counts come from these rows, so a project that was skipped,
// already up to date or held back for review is never counted as published.
export function BulkResultPanel({ title, results, onReview, onDismiss }: BulkResultPanelProps) {
  return (
    <section
      aria-label="Batch results"
      data-testid="bulk-results"
      className="flex max-h-[min(40vh,24rem)] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <h2 className="font-semibold text-gray-900 dark:text-white">{title}</h2>
        <button onClick={onDismiss} aria-label="Dismiss batch results" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <X className="w-4 h-4" />
        </button>
      </div>
      <ul className="divide-y divide-gray-100 overflow-auto px-4 pb-2 dark:divide-gray-700">
        {results.map((result) => (
          <li
            key={result.projectId}
            className="flex items-start gap-3 py-2 text-sm"
            data-testid="bulk-row"
            data-outcome={result.outcome}
          >
            <span className="mt-0.5">{OUTCOME_ICON[result.outcome]}</span>
            <div className="flex-1 min-w-0">
              <p className="text-gray-900 dark:text-white">
                <span className="font-medium">{result.name}</span>{' '}
                <span className="text-gray-500 dark:text-gray-400">{OUTCOME_LABEL[result.outcome]}</span>
              </p>
              <p className="text-gray-600 dark:text-gray-400 break-words">{result.message}</p>
            </div>
            {result.outcome === 'needs_review' && (
              <button
                onClick={() => onReview(result.projectId)}
                className="flex-shrink-0 px-3 py-1 text-sm text-teal-700 dark:text-teal-300 border border-teal-300 dark:border-teal-700 rounded-lg hover:bg-teal-50 dark:hover:bg-teal-900/30"
              >
                Review project
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
