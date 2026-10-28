import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { open } from '@tauri-apps/api/dialog';
import { X, ArrowLeft, ArrowRight, Check, Github, FolderGit, Search, Loader2 } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import toast from 'react-hot-toast';

interface AddProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface GitHubRepo {
  name: string;
  owner: string;
  fullName: string;
  cloneUrl: string;
  description?: string;
}

type Step = 1 | 2 | 3;

export function AddProjectModal({ isOpen, onClose }: AddProjectModalProps) {
  const { createProject, loadProjects, projects, settings } = useAppStore();

  const [mode, setMode] = useState<'local' | 'wizard'>('local');

  // Step state
  const [currentStep, setCurrentStep] = useState<Step>(1);

  // Step 1: Project Name
  const [projectName, setProjectName] = useState('');

  // Step 2: GitHub
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selectedGitHub, setSelectedGitHub] = useState<GitHubRepo | null>(null);
  const [githubUrl, setGithubUrl] = useState('');
  const [githubSearchQuery, setGithubSearchQuery] = useState('');
  const [useManualGitHub, setUseManualGitHub] = useState(false);

  // Step 3: Local Directory
  const [localPath, setLocalPath] = useState('');

  // Loading states
  const [isCreating, setIsCreating] = useState(false);

  // Local folder tab: pick a directory and list the Git repositories under it.
  const [scanRoot, setScanRoot] = useState('');
  const [foundRepos, setFoundRepos] = useState<string[]>([]);
  const [selectedRepoPaths, setSelectedRepoPaths] = useState<Set<string>>(new Set());
  const [isScanning, setIsScanning] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  // Reset modal when opened
  useEffect(() => {
    if (isOpen) {
      resetModal();
    }
  }, [isOpen]);

  const resetModal = () => {
    setMode('local');
    setCurrentStep(1);
    setProjectName('');
    setSelectedGitHub(null);
    setGithubUrl('');
    setLocalPath('');
    setGithubSearchQuery('');
    setUseManualGitHub(false);
    setGithubRepos([]);
    setScanRoot('');
    setFoundRepos([]);
    setSelectedRepoPaths(new Set());
  };

  // Load GitHub repos when reaching step 2
  useEffect(() => {
    if (currentStep === 2 && !useManualGitHub && githubRepos.length === 0) {
      loadGitHubRepos();
    }
  }, [currentStep, useManualGitHub]);

  const loadGitHubRepos = async () => {
    setLoadingRepos(true);
    try {
      // Get the stored credentials to get username
      const credentials = await invoke<{ username: string; hasToken: boolean }>('get_stored_github_credentials');

      if (!credentials.username) {
        toast.error('No GitHub username found. Please configure in Settings.', {
          duration: 4000,
        });
        setLoadingRepos(false);
        return;
      }

      // Try to get the token - this will fail if no token exists
      let token: string;
      try {
        token = await invoke<string>('get_github_token', { username: credentials.username });
      } catch (tokenError) {
        console.error('Failed to get token:', tokenError);
        toast.error('No GitHub token found. Please configure in Settings.', {
          duration: 4000,
        });
        setLoadingRepos(false);
        return;
      }

      // Fetch GitHub repos using the git service
      const repos = await invoke<any[]>('fetch_github_repos', { token });

      // Transform to our format
      const transformed: GitHubRepo[] = repos.map(repo => ({
        name: repo.name,
        owner: repo.githubOwner || credentials.username,
        fullName: repo.githubRepo || `${credentials.username}/${repo.name}`,
        cloneUrl: repo.githubUrl || '',
        description: '',
      }));

      setGithubRepos(transformed);

      if (transformed.length === 0) {
        toast('No repositories found on your GitHub account.', {
          icon: 'ℹ️',
        });
      }
    } catch (error: any) {
      console.error('Failed to load GitHub repos:', error);
      toast.error(`Failed to load GitHub repositories: ${error}`);
    } finally {
      setLoadingRepos(false);
    }
  };

  const handleBrowseDirectory = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Local Directory',
      });

      if (selected && typeof selected === 'string') {
        setLocalPath(selected);
      }
    } catch (error) {
      console.error('Failed to open directory picker:', error);
    }
  };

  const canProceedFromStep1 = projectName.trim().length > 0;

  const canProceedFromStep2 = true; // Always allow skipping GitHub

  const handleNext = () => {
    if (currentStep === 1 && canProceedFromStep1) {
      setCurrentStep(2);
    } else if (currentStep === 2 && canProceedFromStep2) {
      setCurrentStep(3);
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep((currentStep - 1) as Step);
    }
  };

  const handleCreate = async () => {
    if (!projectName.trim()) {
      toast.error('Project name is required');
      return;
    }

    setIsCreating(true);
    try {
      // Parse GitHub info
      let githubOwner: string | undefined;
      let githubRepo: string | undefined;
      let finalGithubUrl: string | undefined;

      if (selectedGitHub) {
        githubOwner = selectedGitHub.owner;
        githubRepo = selectedGitHub.name;
        finalGithubUrl = selectedGitHub.cloneUrl;
      } else if (githubUrl && githubUrl.trim()) {
        // Parse manual URL
        const match = githubUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
        if (match) {
          githubOwner = match[1];
          githubRepo = match[2];
          finalGithubUrl = githubUrl;
        } else {
          toast.error('Invalid GitHub URL format');
          setIsCreating(false);
          return;
        }
      }

      await createProject(
        projectName,
        githubOwner,
        githubRepo,
        finalGithubUrl,
        localPath || undefined
      );

      toast.success(`Project "${projectName}" created successfully!`);
      onClose();
    } catch (error: any) {
      console.error('Failed to create project:', error);
      toast.error(`Failed to create project: ${error}`);
    } finally {
      setIsCreating(false);
    }
  };

  const pathKey = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

  const knownPaths = new Set(
    projects.map((project) => project.localPath).filter((path): path is string => Boolean(path)).map(pathKey)
  );

  const handleScanFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select a folder to scan for Git repositories',
      });
      if (!selected || typeof selected !== 'string') return;

      setScanRoot(selected);
      setIsScanning(true);
      setFoundRepos([]);
      setSelectedRepoPaths(new Set());
      const repos = await invoke<string[]>('scan_directories', {
        directories: [selected],
        maxDepth: settings.scanning.depth || 3,
        excludePatterns: settings.scanning.excludePatterns.length > 0
          ? settings.scanning.excludePatterns
          : ['node_modules', 'target', 'dist', 'build'],
      });
      setFoundRepos(repos);
      setSelectedRepoPaths(new Set(repos.filter((path) => !knownPaths.has(pathKey(path)))));
      if (repos.length === 0) {
        toast('No Git repositories in this folder or its subfolders.');
      }
    } catch (error) {
      toast.error(`Scan failed: ${error}`);
    } finally {
      setIsScanning(false);
    }
  };

  const toggleRepo = (path: string) => {
    setSelectedRepoPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleAddScanned = async () => {
    const repoPaths = [...selectedRepoPaths];
    if (repoPaths.length === 0) return;
    setIsAdding(true);
    try {
      const knownIds = new Set(projects.map((project) => project.id));
      const saved = await invoke<Array<{ id: string }>>('add_repositories', { repoPaths });
      const added = saved.filter((project) => !knownIds.has(project.id)).length;
      await loadProjects();
      toast.success(
        added > 0
          ? `Added ${added} project${added === 1 ? '' : 's'}`
          : 'Those folders are already in BitGit'
      );
      onClose();
    } catch (error) {
      toast.error(`Failed to add projects: ${error}`);
    } finally {
      setIsAdding(false);
    }
  };

  const filteredRepos = githubRepos.filter(repo =>
    repo.name.toLowerCase().includes(githubSearchQuery.toLowerCase()) ||
    repo.fullName.toLowerCase().includes(githubSearchQuery.toLowerCase())
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Add Project</h2>
            <p className="text-sm text-gray-600 mt-1">
              {mode === 'local' ? 'Scan a local folder for Git repositories' : `Step ${currentStep} of 3`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="px-6 pt-4">
          <div className="flex items-center gap-2 bg-gray-100 rounded-lg p-1" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'local'}
              onClick={() => setMode('local')}
              className={`flex-1 px-3 py-2 rounded-md text-sm transition-colors ${
                mode === 'local' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Local folder
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'wizard'}
              onClick={() => setMode('wizard')}
              className={`flex-1 px-3 py-2 rounded-md text-sm transition-colors ${
                mode === 'wizard' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Create step by step
            </button>
          </div>
        </div>

        {/* Progress Bar */}
        {mode === 'wizard' && (
        <div className="px-6 pt-4">
          <div className="flex items-center gap-2">
            {[1, 2, 3].map((step) => (
              <div key={step} className="flex-1">
                <div
                  className={`h-2 rounded-full transition-colors ${
                    step <= currentStep ? 'bg-teal-600' : 'bg-gray-200'
                  }`}
                />
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-2 text-xs text-gray-600">
            <span>Name</span>
            <span>GitHub</span>
            <span>Local</span>
          </div>
        </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {mode === 'local' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                Choose a folder. BitGit checks that folder and its subfolders and lists the ones that are Git repositories.
              </p>
              <button
                type="button"
                onClick={() => void handleScanFolder()}
                disabled={isScanning}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 text-gray-700 bg-white border-2 border-gray-300 rounded-lg hover:border-teal-600 hover:bg-teal-50 transition-colors disabled:opacity-50"
              >
                {isScanning ? <Loader2 className="w-5 h-5 animate-spin" /> : <FolderGit className="w-5 h-5" />}
                {scanRoot ? 'Choose another folder' : 'Choose folder'}
              </button>
              {scanRoot && (
                <p className="text-sm text-gray-700 break-all">{scanRoot}</p>
              )}
              {scanRoot && !isScanning && (
                foundRepos.length === 0 ? (
                  <p className="text-sm text-gray-500">No Git repositories found.</p>
                ) : (
                  <div className="border border-gray-300 rounded-lg max-h-64 overflow-y-auto">
                    {foundRepos.map((path) => {
                      const already = knownPaths.has(pathKey(path));
                      const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
                      return (
                        <label
                          key={path}
                          className={`flex items-start gap-3 px-4 py-3 border-b border-gray-200 last:border-b-0 ${already ? 'opacity-60' : 'cursor-pointer hover:bg-gray-50'}`}
                        >
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={selectedRepoPaths.has(path)}
                            disabled={already}
                            onChange={() => toggleRepo(path)}
                          />
                          <span className="min-w-0">
                            <span className="block font-medium text-gray-900">{name}</span>
                            <span className="block text-xs text-gray-500 break-all">{path}</span>
                            {already && <span className="block text-xs text-gray-500">Already in BitGit</span>}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )
              )}
            </div>
          )}

          {mode === 'wizard' && currentStep === 1 && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Project Name *
                </label>
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="my-awesome-project"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  autoFocus
                />
                <p className="text-xs text-gray-500 mt-2">
                  Give your project a descriptive name. You can change this later.
                </p>
              </div>
            </div>
          )}

          {/* Step 2: Link GitHub */}
          {mode === 'wizard' && currentStep === 2 && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Link GitHub Repository (Optional)
                </label>
                <p className="text-sm text-gray-600 mb-4">
                  Connect this project to a GitHub repository, or skip to configure later.
                </p>

                <div className="flex gap-2 mb-4">
                  <button
                    onClick={() => setUseManualGitHub(false)}
                    className={`flex-1 px-4 py-2 rounded-lg border-2 transition-colors ${
                      !useManualGitHub
                        ? 'border-teal-600 bg-teal-50 text-teal-700'
                        : 'border-gray-300 text-gray-700 hover:border-gray-400'
                    }`}
                  >
                    Select from List
                  </button>
                  <button
                    onClick={() => setUseManualGitHub(true)}
                    className={`flex-1 px-4 py-2 rounded-lg border-2 transition-colors ${
                      useManualGitHub
                        ? 'border-teal-600 bg-teal-50 text-teal-700'
                        : 'border-gray-300 text-gray-700 hover:border-gray-400'
                    }`}
                  >
                    Enter URL Manually
                  </button>
                </div>

                {!useManualGitHub ? (
                  <>
                    {/* Search Bar */}
                    <div className="relative mb-4">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                      <input
                        type="text"
                        value={githubSearchQuery}
                        onChange={(e) => setGithubSearchQuery(e.target.value)}
                        placeholder="Search repositories..."
                        className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                      />
                    </div>

                    {/* Repository List */}
                    {loadingRepos ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-6 h-6 animate-spin text-teal-600" />
                        <span className="ml-2 text-gray-600">Loading repositories...</span>
                      </div>
                    ) : filteredRepos.length > 0 ? (
                      <div className="border border-gray-300 rounded-lg max-h-64 overflow-y-auto">
                        {filteredRepos.map((repo) => (
                          <button
                            key={repo.fullName}
                            onClick={() => {
                              setSelectedGitHub(repo);
                              if (!projectName) {
                                setProjectName(repo.name);
                              }
                            }}
                            className={`w-full px-4 py-3 text-left hover:bg-gray-50 border-b border-gray-200 last:border-b-0 transition-colors ${
                              selectedGitHub?.fullName === repo.fullName ? 'bg-teal-50' : ''
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <Github className="w-5 h-5 text-gray-600" />
                              <div className="flex-1">
                                <div className="font-medium text-gray-900">{repo.name}</div>
                                <div className="text-sm text-gray-500">{repo.fullName}</div>
                              </div>
                              {selectedGitHub?.fullName === repo.fullName && (
                                <Check className="w-5 h-5 text-teal-600" />
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-8">
                        <p className="text-gray-500 mb-3">
                          {githubRepos.length === 0 ? 'No repositories found' : 'No matching repositories'}
                        </p>
                        <button
                          onClick={() => setUseManualGitHub(true)}
                          className="text-sm text-teal-600 hover:text-teal-700 underline"
                        >
                          Enter GitHub URL manually instead
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div>
                    <input
                      type="text"
                      value={githubUrl}
                      onChange={(e) => setGithubUrl(e.target.value)}
                      placeholder="https://github.com/username/repository"
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                    />
                    <p className="text-xs text-gray-500 mt-2">
                      Enter the full GitHub repository URL
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 3: Link Local Directory */}
          {mode === 'wizard' && currentStep === 3 && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Link Local Directory (Optional)
                </label>
                <p className="text-sm text-gray-600 mb-4">
                  Connect this project to a local directory, or skip to configure later.
                </p>

                <div className="space-y-3">
                  <button
                    onClick={handleBrowseDirectory}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 text-gray-700 bg-white border-2 border-gray-300 rounded-lg hover:border-teal-600 hover:bg-teal-50 transition-colors"
                  >
                    <FolderGit className="w-5 h-5" />
                    Browse for Directory
                  </button>

                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-gray-300"></div>
                    </div>
                    <div className="relative flex justify-center text-sm">
                      <span className="px-2 bg-white text-gray-500">or</span>
                    </div>
                  </div>

                  <input
                    type="text"
                    value={localPath}
                    onChange={(e) => setLocalPath(e.target.value)}
                    placeholder="C:\Projects\my-project"
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  />
                </div>

                {localPath && (
                  <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <div className="flex items-start gap-2">
                      <FolderGit className="w-5 h-5 text-blue-600 mt-0.5" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-blue-900">Selected Directory</p>
                        <p className="text-sm text-blue-700 break-all">{localPath}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-gray-200 bg-gray-50">
          {mode === 'local' ? (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleAddScanned()}
                disabled={isAdding || selectedRepoPaths.size === 0}
                className="flex items-center gap-2 px-6 py-2 text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isAdding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Add {selectedRepoPaths.size > 0 ? selectedRepoPaths.size : ''} selected
              </button>
            </>
          ) : (
          <>
          <div className="flex gap-2">
            {currentStep > 1 && (
              <button
                onClick={handleBack}
                className="flex items-center gap-2 px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>

            {currentStep < 3 ? (
              <button
                onClick={handleNext}
                disabled={currentStep === 1 && !canProceedFromStep1}
                className="flex items-center gap-2 px-4 py-2 text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {currentStep === 2 && !selectedGitHub && !githubUrl ? 'Skip' : 'Next'}
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={handleCreate}
                disabled={isCreating}
                className="flex items-center gap-2 px-6 py-2 text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isCreating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    Create Project
                  </>
                )}
              </button>
            )}
          </div>
          </>
          )}
        </div>
      </div>
    </div>
  );
}
