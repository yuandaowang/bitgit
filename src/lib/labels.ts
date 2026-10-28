// Mirrors the Rust label rules so the card can explain a rejection before the save.

export const MAX_LABELS = 8;
export const MAX_LABEL_CHARS = 24;

export function collapseLabelSpace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function labelCharAllowed(char: string): boolean {
  return char === ' ' || char === '-' || /[\p{L}\p{N}]/u.test(char);
}

export function normalizeLabels(input: string[]): { ok: true; labels: string[] } | { ok: false; reason: string } {
  const labels: string[] = [];
  for (const raw of input) {
    const label = collapseLabelSpace(raw);
    if (!label) continue;
    if ([...label].length > MAX_LABEL_CHARS) {
      return { ok: false, reason: `Label "${label}" is longer than ${MAX_LABEL_CHARS} characters` };
    }
    if (![...label].every(labelCharAllowed)) {
      return { ok: false, reason: `Label "${label}" can only use letters, numbers, spaces, hyphens, or CJK characters` };
    }
    if (labels.some((existing) => existing.toLowerCase() === label.toLowerCase())) continue;
    labels.push(label);
    if (labels.length > MAX_LABELS) {
      return { ok: false, reason: `A project can have at most ${MAX_LABELS} labels` };
    }
  }
  return { ok: true, labels };
}

export function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const LABEL_COLORS = [
  'bg-teal-50 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200',
  'bg-sky-50 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  'bg-violet-50 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200',
  'bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  'bg-rose-50 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  'bg-lime-50 text-lime-800 dark:bg-lime-900/40 dark:text-lime-200',
];

export function labelColorClass(name: string): string {
  let hash = 0;
  for (const char of name.toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return LABEL_COLORS[hash % LABEL_COLORS.length];
}

export interface LabelCount {
  name: string;
  count: number;
}

// First spelling wins. Order is use count, then name.
export function labelCatalog(projects: { labels?: string[] }[]): LabelCount[] {
  const byKey = new Map<string, LabelCount>();
  for (const project of projects) {
    for (const label of project.labels ?? []) {
      const key = label.toLowerCase();
      const current = byKey.get(key);
      if (current) current.count += 1;
      else byKey.set(key, { name: label, count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
