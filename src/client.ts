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
      (i.type === 'dir' || i.name.endsWith('.md')))
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

interface GitHubItem { name: string; path: string; type: string }
interface GitHubTreeItem { path: string; type: 'blob' | 'tree' }
interface GitHubTreeResponse { tree: GitHubTreeItem[]; truncated: boolean }

export function createDocsClient(options: DocsClientOptions = {}): DocsClient {
  const owner = options.owner ?? DEFAULTS.owner;
  const repo = options.repo ?? DEFAULTS.repo;
  const branch = options.branch ?? DEFAULTS.branch;
  const token = options.token ?? (typeof process !== 'undefined'
    ? (process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'])
    : undefined);

  const dirCache  = new TtlCache<DocItem[]>(options.cacheTtlMs?.dir  ?? DEFAULTS.dirTtlMs,  30);
  const fileCache = new TtlCache<string>   (options.cacheTtlMs?.file ?? DEFAULTS.fileTtlMs, 50);
  const treeCache = new TtlCache<DocItem[]>(options.cacheTtlMs?.dir  ?? DEFAULTS.dirTtlMs,   1);

  function headers(): Record<string, string> {
    const h: Record<string, string> = { 'Accept': 'application/vnd.github.v3+json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }

  async function ghFetch(url: string, timeoutMs = 10_000): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: headers() });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async function listDir(path = ''): Promise<DocItem[]> {
    const key = path || '__root__';
    const hit = dirCache.get(key);
    if (hit) return hit;

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
    let res: Response;
    try {
      res = await ghFetch(url);
    } catch (err) {
      const stale = dirCache.getStale(key);
      if (stale) return stale;
      const msg = err instanceof Error && err.name === 'AbortError'
        ? 'Request timed out' : String(err);
      throw new DocsFetchError(path, null, msg);
    }

    if (!res.ok) {
      const stale = dirCache.getStale(key);
      if (stale) return stale;
      throw new DocsFetchError(path, res.status, `HTTP ${res.status}`);
    }

    const data = (await res.json()) as GitHubItem[];
    const items = filterAndSort(data);
    dirCache.set(key, items);
    return items;
  }

  async function listAll(): Promise<DocItem[]> {
    const key = '__tree__';
    const hit = treeCache.get(key);
    if (hit) return hit;

    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    let res: Response;
    try {
      res = await ghFetch(url, 20_000);
    } catch (err) {
      const stale = treeCache.getStale(key);
      if (stale) return stale;
      const msg = err instanceof Error && err.name === 'AbortError'
        ? 'Request timed out' : String(err);
      throw new DocsFetchError('', null, msg);
    }

    if (!res.ok) {
      const stale = treeCache.getStale(key);
      if (stale) return stale;
      throw new DocsFetchError('', res.status, `HTTP ${res.status}`);
    }

    const data = (await res.json()) as GitHubTreeResponse;
    const items = filterTree(data.tree);
    treeCache.set(key, items);
    return items;
  }

  async function getFile(path: string): Promise<string> {
    const hit = fileCache.get(path);
    if (hit) return hit;

    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
    let res: Response;
    try {
      res = await ghFetch(url, 15_000);
    } catch (err) {
      const stale = fileCache.getStale(path);
      if (stale) return stale;
      const msg = err instanceof Error && err.name === 'AbortError'
        ? 'Request timed out' : String(err);
      throw new DocsFetchError(path, null, msg);
    }

    if (!res.ok) {
      const stale = fileCache.getStale(path);
      if (stale) return stale;
      throw new DocsFetchError(path, res.status, `HTTP ${res.status}`);
    }

    const content = await res.text();
    fileCache.set(path, content);
    return content;
  }

  function clear(): void {
    dirCache.clear();
    fileCache.clear();
    treeCache.clear();
  }

  return { listDir, listAll, getFile, clear };
}
