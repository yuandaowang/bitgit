// Board display preference. UI-only; a bad value is dropped so the board falls back to the
// current detailed list instead of throwing.

export type BoardDensity = 'detail' | 'simple';
export type BoardLayout = 'list' | 'grid';

export interface DashboardView {
  density: BoardDensity;
  layout: BoardLayout;
}

export const DASHBOARD_VIEW_KEY = 'bitgit.dashboard.view';

export const DEFAULT_DASHBOARD_VIEW: DashboardView = {
  density: 'detail',
  layout: 'list',
};

function isDensity(value: unknown): value is BoardDensity {
  return value === 'detail' || value === 'simple';
}

function isLayout(value: unknown): value is BoardLayout {
  return value === 'list' || value === 'grid';
}

export function readDashboardView(storage: Storage = window.localStorage): DashboardView {
  try {
    const raw = storage.getItem(DASHBOARD_VIEW_KEY);
    if (!raw) return DEFAULT_DASHBOARD_VIEW;
    const parsed = JSON.parse(raw) as { density?: unknown; layout?: unknown };
    if (!isDensity(parsed?.density) || !isLayout(parsed?.layout)) {
      storage.removeItem(DASHBOARD_VIEW_KEY);
      return DEFAULT_DASHBOARD_VIEW;
    }
    return { density: parsed.density, layout: parsed.layout };
  } catch {
    storage.removeItem(DASHBOARD_VIEW_KEY);
    return DEFAULT_DASHBOARD_VIEW;
  }
}

export function writeDashboardView(view: DashboardView, storage: Storage = window.localStorage) {
  storage.setItem(DASHBOARD_VIEW_KEY, JSON.stringify(view));
}
