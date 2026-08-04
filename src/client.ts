import { TtlCache } from './cache.js';
import { DocsFetchError } from './types.js';
import type { DocItem, DocsClient, DocsClientOptions } from './types.js';

const DEFAULTS = {
  owner: 'nbtca',
  repo: 'documents',
  branch: 'main',
  dirTtlMs: 5 * 60 * 1000,
  fileTtlMs: 10 * 60 * 1000,
} as const;

const SKIP = new Set(['.github', '.husky', '.vitepress', '.vscode', 'node_modules',
  'assets', 'public', 'scripts', 'utils', 'package.json', 'pnpm-lock.yaml',
  'tsconfig.json', 'eslint.config.mjs', '.nvmrc', '.gitignore',
  '.markdownlint-cli2.jsonc', 'CONTRIBUTING.md', 'CONTEXT.md']);

function filterAndSort(raw: GitHubItem[]): DocItem[] {
  return raw
    .filter(i => !i.name.startsWith('.') && !SKIP.has(i.name) &&
      (i.type === 'dir' || (i.type === 'file' && i.name.endsWith('.md'))))
    .map(i => ({ name: i.name, path: i.path, type: (i.type === 'dir' ? 'dir' : 'file') as 'dir' | 'file' }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function filterTree(items: GitHubTreeItem[]): DocItem[] {
  return items
    .filter(i => {
      const parts = i.path.split('/');
      if (parts.some(p => p.startsWith('.') || SKIP.has(p))) return false;
      // Only return .md files; directories are navigated via listDir
      return i.type === 'blob' && i.path.endsWith('.md');
    })
    .map(i => ({
      name: i.path.split('/').pop()!,
      path: i.path,
      type: 'file' as const,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function copyItems(items: DocItem[]): DocItem[] {
  return items.map(item => ({ ...item }));
}

interface GitHubItem { name: string; path: string; type: string }
interface GitHubTreeItem { path: string; type: string }
interface GitHubTreeResponse { tree: GitHubTreeItem[]; truncated: boolean }

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function assertRepositoryPath(path: string, allowEmpty: boolean): void {
  if (allowEmpty && path === '') return;
  const parts = path.split('/');
  if (
    path === ''
    || path.startsWith('/')
    || path.endsWith('/')
    || path.includes('\\')
    || parts.some(part => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError('path must be a normalized repository-relative path');
  }
}

function assertRepositoryCoordinate(value: string, name: string): void {
  if (
    value === ''
    || value !== value.trim()
    || value === '.'
    || value === '..'
    || /[\/\\\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${name} must be a valid GitHub repository coordinate`);
  }
}

function assertBranchRef(value: string): void {
  const parts = value.split('/');
  if (
    value === ''
    || value !== value.trim()
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
    || parts.some(part => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError('branch must be a valid Git ref');
  }
}

function cacheTtl(value: number | undefined, fallback: number, name: string): number {
  const ttl = value ?? fallback;
  if (!Number.isFinite(ttl) || ttl < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return ttl;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGitHubItem(value: unknown): value is GitHubItem {
  return isRecord(value) && typeof value.name === 'string' &&
    typeof value.path === 'string' && typeof value.type === 'string';
}

function isGitHubTreeItem(value: unknown): value is GitHubTreeItem {
  return isRecord(value) && typeof value.path === 'string' &&
    typeof value.type === 'string';
}

function parseContentsResponse(value: unknown): GitHubItem[] {
  if (!Array.isArray(value) || !value.every(isGitHubItem)) {
    throw new TypeError('Invalid GitHub contents response');
  }
  return value;
}

function parseTreeResponse(value: unknown): GitHubTreeResponse {
  if (!isRecord(value) || typeof value.truncated !== 'boolean' ||
      !Array.isArray(value.tree) || !value.tree.every(isGitHubTreeItem)) {
    throw new TypeError('Invalid GitHub tree response');
  }
  return { tree: value.tree, truncated: value.truncated };
}

export function createDocsClient(options: DocsClientOptions = {}): DocsClient {
  const owner = options.owner ?? DEFAULTS.owner;
  const repo = options.repo ?? DEFAULTS.repo;
  const branch = options.branch ?? DEFAULTS.branch;
  assertRepositoryCoordinate(owner, 'owner');
  assertRepositoryCoordinate(repo, 'repo');
  assertBranchRef(branch);
  const token = options.token ?? (typeof process !== 'undefined'
    ? (process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'])
    : undefined);
  const apiRepoUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const rawRepoUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const encodedBranch = encodeURIComponent(branch);
  const dirTtlMs = cacheTtl(options.cacheTtlMs?.dir, DEFAULTS.dirTtlMs, 'cacheTtlMs.dir');
  const fileTtlMs = cacheTtl(options.cacheTtlMs?.file, DEFAULTS.fileTtlMs, 'cacheTtlMs.file');

  const dirCache  = new TtlCache<DocItem[]>(dirTtlMs, 30);
  const fileCache = new TtlCache<string>(fileTtlMs, 50);
  const treeCache = new TtlCache<DocItem[]>(dirTtlMs, 1);
  const dirRequests = new Map<string, Promise<DocItem[]>>();
  const fileRequests = new Map<string, Promise<string>>();
  const treeRequests = new Map<string, Promise<DocItem[]>>();
  let cacheGeneration = 0;

  function headers(): Record<string, string> {
    const h: Record<string, string> = { 'Accept': 'application/vnd.github.v3+json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }

  async function withResponse<T>(
    url: string,
    timeoutMs: number,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: ctrl.signal, headers: headers() });
      return await consume(response);
    } finally {
      clearTimeout(timer);
    }
  }

  function recoverFailure<T>(
    cache: TtlCache<T>,
    key: string,
    path: string,
    error: unknown,
    copy: (value: T) => T = value => value,
  ): T {
    const stale = cache.getStale(key);
    if (stale !== undefined) return copy(stale);
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'Request timed out'
      : String(error);
    throw new DocsFetchError(path, null, message);
  }

  function shareRequest<T>(
    requests: Map<string, Promise<T>>,
    key: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const pending = requests.get(key);
    if (pending) return pending;
    const request = load();
    const release = () => {
      if (requests.get(key) === request) requests.delete(key);
    };
    void request.then(release, release);
    requests.set(key, request);
    return request;
  }

  async function loadDir(path: string, key: string, generation: number): Promise<DocItem[]> {
    const url = `${apiRepoUrl}/contents/${encodePath(path)}?ref=${encodedBranch}`;
    try {
      return await withResponse(url, 10_000, async response => {
        if (!response.ok) {
          const stale = dirCache.getStale(key);
          if (isTransientStatus(response.status) && stale !== undefined) return copyItems(stale);
          throw new DocsFetchError(path, response.status, `HTTP ${response.status}`);
        }
        const data = parseContentsResponse(await response.json());
        const items = filterAndSort(data);
        if (generation === cacheGeneration) dirCache.set(key, copyItems(items));
        return items;
      });
    } catch (error) {
      if (error instanceof DocsFetchError) throw error;
      return recoverFailure(dirCache, key, path, error, copyItems);
    }
  }

  function listDir(path = ''): Promise<DocItem[]> {
    try {
      assertRepositoryPath(path, true);
    } catch (error) {
      return Promise.reject(error);
    }
    const hit = dirCache.get(path);
    if (hit) return Promise.resolve(copyItems(hit));
    return shareRequest(dirRequests, path, () => loadDir(path, path, cacheGeneration));
  }

  async function loadAll(generation: number): Promise<DocItem[]> {
    const key = '__tree__';
    const url = `${apiRepoUrl}/git/trees/${encodedBranch}?recursive=1`;
    try {
      return await withResponse(url, 20_000, async response => {
        if (!response.ok) {
          const stale = treeCache.getStale(key);
          if (isTransientStatus(response.status) && stale !== undefined) return copyItems(stale);
          throw new DocsFetchError('', response.status, `HTTP ${response.status}`);
        }
        const data = parseTreeResponse(await response.json());
        if (data.truncated) {
          const stale = treeCache.getStale(key);
          if (stale !== undefined) return copyItems(stale);
          throw new DocsFetchError('', null, 'GitHub truncated the repository tree (too many files) -- results would be incomplete');
        }
        const items = filterTree(data.tree);
        if (generation === cacheGeneration) treeCache.set(key, copyItems(items));
        return items;
      });
    } catch (error) {
      if (error instanceof DocsFetchError) throw error;
      return recoverFailure(treeCache, key, '', error, copyItems);
    }
  }

  function listAll(): Promise<DocItem[]> {
    const key = '__tree__';
    const hit = treeCache.get(key);
    if (hit) return Promise.resolve(copyItems(hit));
    return shareRequest(treeRequests, key, () => loadAll(cacheGeneration));
  }

  async function loadFile(path: string, generation: number): Promise<string> {
    const url = `${rawRepoUrl}/${encodedBranch}/${encodePath(path)}`;
    try {
      return await withResponse(url, 15_000, async response => {
        if (!response.ok) {
          const stale = fileCache.getStale(path);
          if (isTransientStatus(response.status) && stale !== undefined) return stale;
          throw new DocsFetchError(path, response.status, `HTTP ${response.status}`);
        }
        const content = await response.text();
        if (generation === cacheGeneration) fileCache.set(path, content);
        return content;
      });
    } catch (error) {
      if (error instanceof DocsFetchError) throw error;
      return recoverFailure(fileCache, path, path, error);
    }
  }

  function getFile(path: string): Promise<string> {
    try {
      assertRepositoryPath(path, false);
    } catch (error) {
      return Promise.reject(error);
    }
    const hit = fileCache.get(path);
    if (hit !== undefined) return Promise.resolve(hit);
    return shareRequest(fileRequests, path, () => loadFile(path, cacheGeneration));
  }

  function clear(): void {
    cacheGeneration += 1;
    dirCache.clear();
    fileCache.clear();
    treeCache.clear();
    dirRequests.clear();
    fileRequests.clear();
    treeRequests.clear();
  }

  return { listDir, listAll, getFile, clear };
}
