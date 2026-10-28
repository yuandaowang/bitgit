// Recent project searches. UI-only, newest first, at most ten. A bad value is dropped.

export const SEARCH_HISTORY_KEY = 'bitgit.dashboard.searchHistory';
export const SEARCH_HISTORY_LIMIT = 10;

export function readSearchHistory(storage: Storage = window.localStorage): string[] {
  try {
    const raw = storage.getItem(SEARCH_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      storage.removeItem(SEARCH_HISTORY_KEY);
      return [];
    }
    return parsed.slice(0, SEARCH_HISTORY_LIMIT);
  } catch {
    storage.removeItem(SEARCH_HISTORY_KEY);
    return [];
  }
}

export function writeSearchHistory(history: string[], storage: Storage = window.localStorage) {
  storage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history.slice(0, SEARCH_HISTORY_LIMIT)));
}

// Blank text is ignored. A case-insensitive match moves to the front and keeps the newest spelling.
export function rememberSearch(history: string[], query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return history;
  const next = [trimmed, ...history.filter((item) => item.toLowerCase() !== trimmed.toLowerCase())];
  return next.slice(0, SEARCH_HISTORY_LIMIT);
}

export function matchingHistory(history: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? history.filter((item) => item.toLowerCase().includes(needle))
    : history;
  return matched.slice(0, SEARCH_HISTORY_LIMIT);
}
