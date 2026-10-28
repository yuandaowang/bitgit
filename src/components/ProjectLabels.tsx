import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import toast from 'react-hot-toast';
import { X } from 'lucide-react';
import type { Project } from '../types';
import { useAppStore } from '../stores/useAppStore';
import { MAX_LABELS, labelColorClass, normalizeLabels, sameLabel } from '../lib/labels';

interface ProjectLabelsProps {
  project: Project;
  catalog: string[];
  compact?: boolean;
}

export function ProjectLabels({ project, catalog, compact = false }: ProjectLabelsProps) {
  const updateProject = useAppStore((state) => state.updateProject);
  const labels = project.labels ?? [];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const atLimit = labels.length >= MAX_LABELS;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const save = async (next: string[]) => {
    const checked = normalizeLabels(next);
    if (!checked.ok) {
      toast.error(checked.reason);
      return;
    }
    setSaving(true);
    try {
      const updated = await invoke<Project>('set_project_labels', {
        projectId: project.id,
        labels: checked.labels,
      });
      await updateProject(updated);
      setDraft('');
      setOpen(false);
    } catch (error) {
      toast.error(`Failed to save labels: ${error}`);
    } finally {
      setSaving(false);
    }
  };

  const query = draft.trim();
  const checkedDraft = query ? normalizeLabels([query]) : null;
  const matches = catalog.filter((name) => {
    if (labels.some((label) => sameLabel(label, name))) return false;
    return !query || name.toLowerCase().includes(query.toLowerCase());
  });
  const exact = catalog.some((name) => sameLabel(name, query)) || labels.some((label) => sameLabel(label, query));
  const canCreate = Boolean(query) && checkedDraft?.ok && !exact && !atLimit;

  return (
    <div className={`flex flex-wrap items-center gap-1.5 min-w-0 ${compact ? '' : 'mb-3'}`} data-testid="project-labels">
      {labels.map((label) => (
        <span
          key={label.toLowerCase()}
          className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 ${compact ? 'text-xs' : 'text-sm'} ${labelColorClass(label)}`}
        >
          <span className="truncate">{label}</span>
          <button
            type="button"
            aria-label={`Remove label ${label}`}
            disabled={saving}
            onClick={() => void save(labels.filter((item) => !sameLabel(item, label)))}
            className="rounded-full opacity-70 hover:opacity-100 disabled:opacity-40"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}

      <div className="relative" ref={boxRef}>
        <button
          type="button"
          disabled={atLimit || saving}
          title={atLimit ? `A project can have at most ${MAX_LABELS} labels` : 'Add a label'}
          onClick={() => setOpen((value) => !value)}
          className="rounded-full border border-dashed border-gray-300 dark:border-gray-600 px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400 hover:border-teal-500 hover:text-teal-700 dark:hover:text-teal-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          + Label
        </button>
        {open && !atLimit && (
          <div className="absolute left-0 z-30 mt-1 w-56 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg p-2">
            <input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canCreate) {
                  event.preventDefault();
                  void save([...labels, query]);
                }
              }}
              placeholder="Find or create"
              className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            />
            {checkedDraft && !checkedDraft.ok && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{checkedDraft.reason}</p>
            )}
            <div className="mt-1 max-h-40 overflow-auto">
              {matches.map((name) => (
                <button
                  key={name.toLowerCase()}
                  type="button"
                  disabled={saving}
                  onClick={() => void save([...labels, name])}
                  className="block w-full text-left px-2 py-1 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 rounded"
                >
                  {name}
                </button>
              ))}
              {canCreate && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void save([...labels, query])}
                  className="block w-full text-left px-2 py-1 text-sm text-teal-700 dark:text-teal-300 hover:bg-teal-50 dark:hover:bg-gray-700 rounded"
                >
                  Create “{query}”
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
