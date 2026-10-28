import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useAppStore } from '../stores/useAppStore';
import { ProjectCard } from './ProjectCard';
import { SettingsModal } from './SettingsModal';
import { AddProjectModal } from './AddProjectModal';
import { AnalyticsDashboard } from './AnalyticsDashboard';
import { BulkResultPanel } from './git/BulkResultPanel';
import type { BulkProjectResult, PublishAction } from '../types';
import { readDashboardView, writeDashboardView, type BoardDensity, type BoardLayout } from '../lib/dashboardView';
import { labelCatalog, sameLabel } from '../lib/labels';
import { LabelFilter } from './LabelFilter';
import { ProjectSearchBox } from './ProjectSearchBox';
import { Plus, RefreshCw, Settings, Sun, Moon, CheckSquare, Square, Upload, Search, Filter, BarChart3, FolderGit2 } from 'lucide-react';

// Shortcuts take Ctrl everywhere and also ⌘ on macOS, where hints show ⌘.
const IS_MAC = navigator.userAgent.includes('Mac');
const MOD = IS_MAC ? '⌘' : 'Ctrl+';

function segmentClass(active: boolean) {
  return `px-3 py-1.5 rounded-md text-sm transition-colors ${
    active
      ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
  }`;
}

export function Dashboard() {
  const {
    projects,
    isLoading,
    loadProjects,
    loadEditorSettings,
    selectedProjectIds,
    settings,
    toggleTheme,
    selectAll,
    clearSelection,
    syncSelected,
    refreshAllProjects,
    requestReview,
    startBackgroundChecking,
    stopBackgroundChecking,
  } = useAppStore();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isRefreshingRef = useRef(false);
  const [isBulkRunning, setIsBulkRunning] = useState(false);
  const [bulk, setBulk] = useState<{ kind: PublishAction['type']; results: BulkProjectResult[] } | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAddProjectOpen, setIsAddProjectOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<'name' | 'favorite' | 'activity'>('favorite');
  const [currentView, setCurrentView] = useState<'projects' | 'analytics'>('projects');
  const [density, setDensity] = useState<BoardDensity>(() => readDashboardView().density);
  const [layout, setLayout] = useState<BoardLayout>(() => readDashboardView().layout);

  // Check actual dark mode state from document class, not just settings
  const isDarkMode = document.documentElement.classList.contains('dark');
  const ThemeIcon = isDarkMode ? Moon : Sun;
  const hasSelection = selectedProjectIds.size > 0;

  // Filter and sort projects
  const filteredProjects = projects
    .filter((project) => {
      // Search filter
      const query = searchQuery.toLowerCase();
      const matchesSearch = project.name.toLowerCase().includes(query) ||
                           project.localPath?.toLowerCase().includes(query) ||
                           (project.githubOwner && project.githubOwner.toLowerCase().includes(query)) ||
                           (project.githubRepo && project.githubRepo.toLowerCase().includes(query)) ||
                           (project.labels ?? []).some((label) => label.toLowerCase().includes(query));

      // Status filter
      const matchesStatus = statusFilter === 'all' || project.projectStatus === statusFilter;

      // Archive filter
      const matchesArchive = showArchived || !project.archived;

      // Favorites filter
      const matchesFavorites = !favoritesOnly || project.favorite;

      const matchesLabels = selectedLabels.length === 0
        || (project.labels ?? []).some((label) => selectedLabels.some((selected) => sameLabel(selected, label)));

      return matchesSearch && matchesStatus && matchesArchive && matchesFavorites && matchesLabels;
    })
    .sort((a, b) => {
      // Sort by favorites first if enabled
      if (sortBy === 'favorite') {
        const aFav = a.favorite ? 1 : 0;
        const bFav = b.favorite ? 1 : 0;
        if (aFav !== bFav) return bFav - aFav;
      }

      // Then by activity
      if (sortBy === 'activity') {
        const aActivity = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
        const bActivity = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
        if (aActivity !== bActivity) return bActivity - aActivity;
      }

      // Finally by name
      return a.name.localeCompare(b.name);
    });

  // Re-reads Git state (and GitHub) for every project with a local folder. It does not reload the
  // list, so open dialogs on the cards are not torn down.
  const handleRefreshAll = useCallback(async () => {
    if (isRefreshingRef.current) return;
    isRefreshingRef.current = true;
    setIsRefreshing(true);
    try {
      const summary = await refreshAllProjects();
      const problems = summary.unavailable + summary.failed;
      const skippedNote = summary.skipped > 0 ? ` ${summary.skipped} skipped because an operation is running.` : '';
      if (summary.checked === 0) {
        toast(`No projects were checked.${skippedNote || ' None has a local folder yet.'}`);
      } else if (problems > 0) {
        toast.error(
          `Checked ${summary.checked} project(s); ${problems} could not be fully checked (GitHub unreachable or not a Git folder). See each project's status.${skippedNote}`,
          { duration: 7000 }
        );
      } else {
        toast.success(`Checked ${summary.checked} project(s).${skippedNote}`);
      }
    } finally {
      isRefreshingRef.current = false;
      setIsRefreshing(false);
    }
  }, [refreshAllProjects]);

  const handleBulk = async (kind: PublishAction['type']) => {
    setIsBulkRunning(true);
    setBulk(null);
    try {
      const results = await syncSelected({ type: kind });
      if (results.length > 0) setBulk({ kind, results });
    } finally {
      setIsBulkRunning(false);
    }
  };

  const handleReview = (projectId: string) => {
    if (!filteredProjects.some((p) => p.id === projectId)) {
      toast('Show this project in the list (clear filters or show archived) to review it.');
      return;
    }
    requestReview({ id: projectId, kind: bulk?.kind ?? 'push_local' });
  };

  useEffect(() => {
    loadProjects();
    loadEditorSettings();

    // Start background status checking if enabled
    if (settings.ui.refreshInterval > 0) {
      startBackgroundChecking();
    }

    // Cleanup: stop background checking when component unmounts
    return () => {
      stopBackgroundChecking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only load once on mount

  useEffect(() => {
    writeDashboardView({ density, layout });
  }, [density, layout]);

  // Update background checking when refresh interval changes
  useEffect(() => {
    if (settings.ui.refreshInterval > 0) {
      startBackgroundChecking();
    } else {
      stopBackgroundChecking();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.ui.refreshInterval]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if user is typing in an input field
      const target = e.target as HTMLElement;
      const isInputField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';

      const modKey = e.ctrlKey || (IS_MAC && e.metaKey);

      // Mod+R: Refresh (re-reads Git state, not just the saved list)
      if (modKey && e.key === 'r') {
        e.preventDefault();
        void handleRefreshAll();
        return;
      }

      // Mod+N: New Project
      if (modKey && e.key === 'n') {
        e.preventDefault();
        setIsAddProjectOpen(true);
        return;
      }

      // Mod+F: Focus search. The box itself reopens history when it already has focus.
      if (modKey && e.key === 'f' && !isInputField) {
        e.preventDefault();
        if (currentView !== 'projects') setCurrentView('projects');
        requestAnimationFrame(() => {
          document.getElementById('project-search')?.focus();
        });
        return;
      }

      // Mod+A: Select All (only if not in an input field)
      if (modKey && e.key === 'a' && !isInputField && projects.length > 0) {
        e.preventDefault();
        selectAll();
        return;
      }

      // Escape: Clear selection
      if (e.key === 'Escape' && hasSelection) {
        clearSelection();
        return;
      }

      // Mod+D: Toggle theme (dark mode)
      if (modKey && e.key === 'd') {
        e.preventDefault();
        toggleTheme();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleRefreshAll, projects.length, hasSelection, selectAll, clearSelection, toggleTheme, currentView]);

  const catalog = labelCatalog(projects);
  const catalogKey = catalog.map((item) => item.name.toLowerCase()).join('\n');
  // A label removed from every project leaves the catalog, so it must leave the filter too.
  useEffect(() => {
    const names = new Set(catalogKey ? catalogKey.split('\n') : []);
    setSelectedLabels((current) => {
      const next = current.filter((label) => names.has(label.toLowerCase()));
      return next.length === current.length ? current : next;
    });
  }, [catalogKey]);

  const boardClass = layout === 'list'
    ? 'space-y-4'
    : density === 'simple'
      ? 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3'
      : 'grid grid-cols-1 xl:grid-cols-2 gap-4';

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <div className="container mx-auto px-8 py-4">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-3xl font-bold text-gray-900 dark:text-white">BitGit</h1>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Loading projects...
                </p>
              </div>
            </div>
          </div>
        </header>
        <main className="container mx-auto px-8 py-8">
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border-l-4 border-gray-300 dark:border-gray-600 p-6 animate-pulse"
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-5 h-5 bg-gray-300 dark:bg-gray-600 rounded"></div>
                  <div className="flex-1">
                    <div className="h-6 bg-gray-300 dark:bg-gray-600 rounded w-48 mb-2"></div>
                    <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-32"></div>
                  </div>
                </div>
                <div className="space-y-2 mb-4">
                  <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-full"></div>
                  <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4"></div>
                </div>
                <div className="flex gap-2">
                  <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded w-32"></div>
                  <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded w-32"></div>
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 sticky top-0 z-10">
        <div className="container mx-auto px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div>
                <h1 className="text-3xl font-bold text-gray-900 dark:text-white">BitGit</h1>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {currentView === 'projects'
                    ? `${filteredProjects.length} of ${projects.length} projects${selectedProjectIds.size > 0 ? ` • ${selectedProjectIds.size} selected` : ''}`
                    : 'Insights & Analytics'
                  }
                </p>
              </div>

              {/* View Toggle */}
              <div className="flex items-center gap-2 bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
                <button
                  onClick={() => setCurrentView('projects')}
                  className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
                    currentView === 'projects'
                      ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                  }`}
                >
                  <FolderGit2 className="w-4 h-4" />
                  Projects
                </button>
                <button
                  onClick={() => setCurrentView('analytics')}
                  className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
                    currentView === 'analytics'
                      ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                  }`}
                >
                  <BarChart3 className="w-4 h-4" />
                  Analytics
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={toggleTheme}
                className="flex items-center gap-2 px-3 py-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                title={`Theme: ${settings.ui.theme} (${MOD}D to toggle)`}
              >
                <ThemeIcon className="w-4 h-4" />
              </button>

              <button
                onClick={() => void handleRefreshAll()}
                disabled={isRefreshing}
                className="flex items-center gap-2 px-4 py-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                title={`Refresh: re-read every project's Git state and check GitHub (${MOD}R)`}
              >
                <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                Refresh
              </button>

              <button
                onClick={() => setIsAddProjectOpen(true)}
                className="flex items-center gap-2 px-4 py-2 text-white bg-teal-600 dark:bg-teal-700 rounded-lg hover:bg-teal-700 dark:hover:bg-teal-800 transition-colors"
                title={`Add new project (${MOD}N)`}
              >
                <Plus className="w-4 h-4" />
                Add Project
              </button>

              <button
                onClick={() => setIsSettingsOpen(true)}
                className="flex items-center gap-2 px-4 py-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <Settings className="w-4 h-4" />
                Settings
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Search, filters, density and layout. */}
      <div className="sticky top-16 z-10">
      {currentView === 'projects' && (
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="container mx-auto px-8 py-4">
          <div className="flex flex-wrap items-center gap-3">
            {/* Search Box */}
            <ProjectSearchBox
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={`Search projects by name, path, or repository... (${MOD}F)`}
            />

            {/* Status Filter */}
            <div className="relative">
              <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 dark:text-gray-500 pointer-events-none" />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="pl-10 pr-10 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-teal-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-white appearance-none cursor-pointer min-w-[180px]"
              >
                <option value="all">All Status</option>
                <option value="synced">Synced</option>
                <option value="needs_push">Needs Push</option>
                <option value="needs_merge">Needs Merge</option>
                <option value="needs_sync">Needs Sync</option>
                <option value="ready">Ready</option>
                <option value="github_only">GitHub Only</option>
                <option value="local_only">Local Only</option>
                <option value="not_configured">Not Configured</option>
              </select>
            </div>

            <LabelFilter options={catalog} selected={selectedLabels} onChange={setSelectedLabels} />

            {/* Favorites Filter */}
            <button
              onClick={() => setFavoritesOnly(!favoritesOnly)}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                favoritesOnly
                  ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 border-2 border-yellow-400 dark:border-yellow-600'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
              title="Show only favorites"
            >
              ⭐ {favoritesOnly ? 'Favorites Only' : 'All'}
            </button>

            {/* Archived Filter */}
            <button
              onClick={() => setShowArchived(!showArchived)}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                showArchived
                  ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 border-2 border-orange-400 dark:border-orange-600'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
              title="Show archived projects"
            >
              {showArchived ? 'With Archived' : 'No Archived'}
            </button>

            {/* Sort dropdown */}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'name' | 'favorite' | 'activity')}
              className="px-4 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-teal-500 min-w-[180px]"
            >
              <option value="favorite">Sort: Favorites First</option>
              <option value="activity">Sort: Recent Activity</option>
              <option value="name">Sort: Name (A-Z)</option>
            </select>

            <div className="flex items-center gap-2 bg-gray-100 dark:bg-gray-700 rounded-lg p-1" role="group" aria-label="Card density">
              <button type="button" aria-pressed={density === 'detail'} onClick={() => setDensity('detail')} className={segmentClass(density === 'detail')}>Detail</button>
              <button type="button" aria-pressed={density === 'simple'} onClick={() => setDensity('simple')} className={segmentClass(density === 'simple')}>Simple</button>
            </div>
            <div className="flex items-center gap-2 bg-gray-100 dark:bg-gray-700 rounded-lg p-1" role="group" aria-label="Board layout">
              <button type="button" aria-pressed={layout === 'list'} onClick={() => setLayout('list')} className={segmentClass(layout === 'list')}>List</button>
              <button type="button" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')} className={segmentClass(layout === 'grid')}>Grid</button>
            </div>
          </div>
        </div>
      </div>
      )}

      </div>

      <main className={`container mx-auto px-8 pt-8 ${currentView === 'projects' && hasSelection ? 'pb-28' : 'pb-8'}`}>
        {currentView === 'projects' && bulk && (
          <BulkResultPanel
            title={bulk.kind === 'full_sync' ? 'Bulk sync results' : 'Bulk push results'}
            results={bulk.results}
            onReview={handleReview}
            onDismiss={() => setBulk(null)}
          />
        )}
        {/* Conditionally render Analytics Dashboard or Projects List */}
        {currentView === 'analytics' ? (
          <AnalyticsDashboard />
        ) : projects.length === 0 ? (
          <EmptyState onAddProject={() => setIsAddProjectOpen(true)} />
        ) : filteredProjects.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-12 text-center">
            <div className="max-w-md mx-auto">
              <Search className="w-12 h-12 text-gray-400 dark:text-gray-600 mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
                No Projects Found
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                No projects match your search or filter criteria. Try adjusting your filters.
              </p>
              <button
                onClick={() => {
                  setSearchQuery('');
                  setStatusFilter('all');
                  setSelectedLabels([]);
                }}
                className="px-6 py-3 text-white bg-teal-600 dark:bg-teal-700 rounded-lg hover:bg-teal-700 dark:hover:bg-teal-800 transition-colors"
              >
                Clear Filters
              </button>
            </div>
          </div>
        ) : (
          <div className={boardClass} data-layout={layout} data-density={density}>
            {filteredProjects.map((project) => (
              <ProjectCard key={project.id} project={project} density={density} labelCatalog={catalog.map((item) => item.name)} />
            ))}
          </div>
        )}
      </main>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onRepositoriesAdded={loadProjects}
      />

      <AddProjectModal
        isOpen={isAddProjectOpen}
        onClose={() => setIsAddProjectOpen(false)}
      />

      {currentView === 'projects' && hasSelection && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30">
          <div className="container mx-auto px-8 pb-6">
            <div
              role="region"
              aria-label="Selected projects"
              className="pointer-events-auto flex flex-wrap items-center justify-between gap-3 rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 shadow-lg animate-rise-in motion-reduce:animate-none dark:border-teal-800 dark:bg-gray-800"
            >
              <div className="flex flex-wrap items-center gap-4">
                <span className="text-sm font-medium text-teal-900 dark:text-teal-100">
                  {selectedProjectIds.size} project{selectedProjectIds.size !== 1 ? 's' : ''} selected
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={selectAll}
                    className="text-sm px-3 py-1.5 text-teal-700 dark:text-teal-300 hover:bg-teal-100 dark:hover:bg-teal-900/40 rounded transition-colors"
                    title={`Select all projects (${MOD}A)`}
                  >
                    <CheckSquare className="w-4 h-4 inline mr-1" />
                    Select All
                  </button>
                  <button
                    onClick={clearSelection}
                    className="text-sm px-3 py-1.5 text-teal-700 dark:text-teal-300 hover:bg-teal-100 dark:hover:bg-teal-900/40 rounded transition-colors"
                    title="Clear selection (Esc)"
                  >
                    <Square className="w-4 h-4 inline mr-1" />
                    Clear
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void handleBulk('push_local')}
                  disabled={isBulkRunning}
                  className="flex items-center gap-2 px-4 py-2 text-white bg-teal-600 dark:bg-teal-700 rounded-lg hover:bg-teal-700 dark:hover:bg-teal-800 transition-colors disabled:opacity-50"
                  title="Push commits you already made. Projects with uncommitted changes are held back for you to review."
                >
                  <Upload className="w-4 h-4" />
                  Bulk Push Commits
                </button>
                <button
                  onClick={() => void handleBulk('full_sync')}
                  disabled={isBulkRunning}
                  className="flex items-center gap-2 px-4 py-2 text-white bg-blue-600 dark:bg-blue-700 rounded-lg hover:bg-blue-700 dark:hover:bg-blue-800 transition-colors disabled:opacity-50"
                  title="Sync each project's current branch with GitHub. Projects with uncommitted changes are held back for you to review."
                >
                  <RefreshCw className="w-4 h-4" />
                  Bulk Sync Branches
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface EmptyStateProps {
  onAddProject: () => void;
}

function EmptyState({ onAddProject }: EmptyStateProps) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-12 text-center">
      <div className="max-w-md mx-auto">
        <div className="w-16 h-16 bg-teal-100 dark:bg-teal-900 rounded-full flex items-center justify-center mx-auto mb-4">
          <Plus className="w-8 h-8 text-teal-600 dark:text-teal-400" />
        </div>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
          No Projects Yet
        </h2>

        <p className="text-gray-600 dark:text-gray-400 mb-6">
          Get started by creating your first project. You can link it to a GitHub repository
          and/or a local directory, or configure those details later.
        </p>

        <button
          onClick={onAddProject}
          className="px-6 py-3 text-white bg-teal-600 dark:bg-teal-700 rounded-lg hover:bg-teal-700 dark:hover:bg-teal-800 transition-colors inline-flex items-center gap-2"
        >
          <Plus className="w-5 h-5" />
          Create Your First Project
        </button>
      </div>
    </div>
  );
}
