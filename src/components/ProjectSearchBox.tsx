import { useEffect, useId, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import {
  matchingHistory,
  readSearchHistory,
  rememberSearch,
  writeSearchHistory,
} from '../lib/searchHistory';

interface ProjectSearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}

export function ProjectSearchBox({ value, onChange, placeholder }: ProjectSearchBoxProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<string[]>(() => readSearchHistory());
  const historyRef = useRef(history);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const items = matchingHistory(history, value);
  const visible = open && items.length > 0;
  const active = items.length === 0 ? 0 : Math.min(highlight, items.length - 1);

  useEffect(() => {
    setHighlight(0);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const store = (next: string[]) => {
    historyRef.current = next;
    setHistory(next);
    writeSearchHistory(next);
  };

  const commit = (query: string) => {
    const next = rememberSearch(historyRef.current, query);
    if (next !== historyRef.current) store(next);
  };

  const apply = (query: string) => {
    onChange(query);
    store(rememberSearch(historyRef.current, query));
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div className="flex-1 relative min-w-[220px]" ref={rootRef}>
      <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
      <input
        id="project-search"
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={visible}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => commit(value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
            event.preventDefault();
            setOpen(true);
            return;
          }
          if (event.key === 'Escape') {
            if (open) event.stopPropagation();
            setOpen(false);
            return;
          }
          if (!visible) {
            if (event.key === 'Enter') commit(value);
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setHighlight((active + 1) % items.length);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setHighlight((active - 1 + items.length) % items.length);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            apply(items[active] ?? value);
          }
        }}
        className="h-8 w-full rounded-lg border border-gray-300 bg-white pl-8 pr-3 text-sm text-gray-900 placeholder-gray-500 focus:border-teal-500 focus:ring-2 focus:ring-teal-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
      />
      {visible && (
        <ul
          id={listId}
          role="listbox"
          onMouseDown={(event) => event.preventDefault()}
          className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg py-1"
        >
          {items.map((item, index) => (
            <li key={item.toLowerCase()} role="option" aria-selected={index === active}>
              <div className={`flex items-center ${index === active ? 'bg-teal-50 dark:bg-teal-900/30' : ''}`}>
                <button
                  type="button"
                  onClick={() => apply(item)}
                  className="flex-1 min-w-0 px-3 py-1.5 text-left text-sm text-gray-800 dark:text-gray-100 truncate"
                >
                  {item}
                </button>
                <button
                  type="button"
                  aria-label={`Remove search ${item}`}
                  onClick={() => store(historyRef.current.filter((entry) => entry.toLowerCase() !== item.toLowerCase()))}
                  className="px-2 py-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
