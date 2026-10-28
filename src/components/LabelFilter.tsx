import { useEffect, useRef, useState } from 'react';
import type { LabelCount } from '../lib/labels';
import { sameLabel } from '../lib/labels';

interface LabelFilterProps {
  options: LabelCount[];
  selected: string[];
  onChange: (selected: string[]) => void;
}

export function LabelFilter({ options, selected, onChange }: LabelFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const empty = options.length === 0;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
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

  const toggle = (name: string) => {
    if (selected.some((item) => sameLabel(item, name))) {
      onChange(selected.filter((item) => !sameLabel(item, name)));
    } else {
      onChange([...selected, name]);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={empty}
        title={empty ? 'Add a label on a project card' : 'Filter by label'}
        onClick={() => setOpen((value) => !value)}
        className={`px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          selected.length > 0
            ? 'bg-teal-50 dark:bg-teal-900/30 text-teal-800 dark:text-teal-200 border-2 border-teal-500'
            : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
        }`}
      >
        Labels{selected.length > 0 ? ` (${selected.length})` : ''}
      </button>
      {open && !empty && (
        <div className="absolute left-0 z-30 mt-1 w-56 max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg p-2">
          {options.map((option) => {
            const checked = selected.some((item) => sameLabel(item, option.name));
            return (
              <label
                key={option.name.toLowerCase()}
                className="flex items-center gap-2 px-2 py-1 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 rounded cursor-pointer"
              >
                <input type="checkbox" checked={checked} onChange={() => toggle(option.name)} />
                <span className="flex-1 truncate">{option.name}</span>
                <span className="text-xs text-gray-400">{option.count}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
