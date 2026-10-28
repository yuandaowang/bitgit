import { useEffect, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import type { LabelCount } from '../lib/labels';
import { sameLabel } from '../lib/labels';

interface LabelFilterProps {
  options: LabelCount[];
  selected: string[];
  onChange: (selected: string[]) => void;
  favoritesOnly: boolean;
  favoriteCount: number;
  onFavoritesOnlyChange: (value: boolean) => void;
}

export function LabelFilter({
  options,
  selected,
  onChange,
  favoritesOnly,
  favoriteCount,
  onFavoritesOnlyChange,
}: LabelFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const activeCount = selected.length + (favoritesOnly ? 1 : 0);

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
        title="Filter by label or favorites"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium transition-colors ${
          activeCount > 0
            ? 'border border-teal-500 bg-teal-50 text-teal-800 dark:border-teal-500 dark:bg-teal-900/30 dark:text-teal-200'
            : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
        }`}
      >
        Labels{activeCount > 0 ? ` (${activeCount})` : ''}
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 w-56 max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg p-2">
          <label className="flex items-center gap-2 px-2 py-1 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 rounded cursor-pointer">
            <input
              type="checkbox"
              checked={favoritesOnly}
              onChange={() => onFavoritesOnlyChange(!favoritesOnly)}
            />
            <Star className={`h-3.5 w-3.5 ${favoritesOnly ? 'fill-yellow-400 text-yellow-500' : 'text-gray-400'}`} aria-hidden="true" />
            <span className="flex-1 truncate">Favorites</span>
            <span className="text-xs text-gray-400">{favoriteCount}</span>
          </label>
          {options.length > 0 && <div className="my-1 border-t border-gray-100 dark:border-gray-700" />}
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
