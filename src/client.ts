import { TtlCache } from './cache.js';
import { parseDoc, searchDoc } from './content.js';
import { DocsFetchError } from './types.js';
import type {
  DocItem,
  DocPage,
  DocSection,
  DocsClient,
  DocsClientOptions,
  DocsSearchOptions,
  DocsSearchResult,
} from './types.js';

const DEFAULTS = {
  owner: 'nbtca',
  repo: 'documents',
  branch: 'main',
  dirTtlMs: 5 * 60 * 1000,
  fileTtlMs: 10 * 60 * 1000,
} as const;

const SKIP = new Set([
  '.github',
  '.husky',
  '.vitepress',
  '.vscode',
  'node_modules',
  'assets',
  'public',
  'scripts',
  'utils',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'eslint.config.mjs',
  '.nvmrc',
  '.gitignore',
  '.markdownlint-cli2.jsonc',
  'CONTRIBUTING.md',
  'CONTEXT.md',
  'README.md',
  'docs',
]);

const TREE_KEY = 'tree';
const MIRROR_TIMEOUT_MS = 5_000;
const SHA = /^[0-9a-f]{40}$/;
const SEARCH_CONCURRENCY = 6;
const SEARCH_RESULT_LIMIT = 20;

function filterAndSort(raw: GitHubItem[]): DocItem[] {
  return raw
    .filter(
      (item) =>
        !item.name.startsWith('.') &&
        !SKIP.has(item.name) &&
        (item.type === 'dir' || (item.type === 'file' && item.name.endsWith('.md'))),
    )
    .map((item): DocItem => ({
      name: item.name,
      path: item.path,
      type: item.type === 'dir' ? 'dir' : 'file',
      ...shaOf(item),
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function filterTree(items: GitHubTreeItem[]): DocItem[] {
  return items
    .filter((item) => {
      const parts = item.path.split('/');
      if (parts.some((part) => part.startsWith('.') || SKIP.has(part))) return false;
      return item.type === 'blob' && item.path.endsWith('.md');
    })
    .map((item) => ({
      name: item.path.slice(item.path.lastIndexOf('/') + 1),
      path: item.path,
      type: 'file' as const,
      ...shaOf(item),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function shaOf(item: { sha?: unknown }): { sha?: string } {
  return typeof item.sha === 'string' && SHA.test(item.sha) ? { sha: item.sha } : {};
}

async function blobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${String(body.length)}\0`);
  const object = new Uint8Array(header.length + body.length);
  object.set(header);
  object.set(body, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', object));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isDocItem(value: unknown): value is DocItem {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.path === 'string' &&
    (value.type === 'file' || value.type === 'dir') &&
    (value.sha === undefined || typeof value.sha === 'string')
  );
}

function parseStoredTree(value: string | undefined): DocItem[] | undefined {
  if (value === undefined) return undefined;
  try {
    const items: unknown = JSON.parse(value);
    return Array.isArray(items) && items.every(isDocItem) ? items : undefined;
  } catch {
    return undefined;
  }
}

function copyItems(items: DocItem[]): DocItem[] {
  return items.map((item) => ({ ...item }));
}

function sectionsFromItems(items: DocItem[]): DocSection[] {
  const sections = new Map<string, DocSection>();
  for (const item of items) {
    const separator = item.path.indexOf('/');
    if (separator < 1) continue;
    const path = item.path.slice(0, separator);
    const current = sections.get(path) ?? { count: 0, path };
    current.count += 1;
    if (item.path === `${path}/index.md`) current.indexPath = item.path;
    sections.set(path, current);
  }
  return [...sections.values()]
    .map((section) => ({ ...section }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function searchLimit(value: number | undefined): number {
  const limit = value ?? SEARCH_RESULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('limit must be a non-negative safe integer');
  }
  return limit;
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value !== undefined) results[index] = await map(value);
    }
  }
  const workers = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

interface GitHubItem {
  name: string;
  path: string;
  type: string;
  sha?: unknown;
}

interface GitHubTreeItem {
  path: string;
  type: string;
  sha?: unknown;
}

interface GitHubTreeResponse {
  tree: GitHubTreeItem[];
  truncated: boolean;
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function assertRepositoryPath(path: string, allowEmpty: boolean): void {
  if (allowEmpty && path === '') return;
  const parts = path.split('/');
  if (
    path === '' ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError('path must be a normalized repository-relative path');
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertRepositoryCoordinate(value: string, name: string): void {
  if (
    value === '' ||
    value !== value.trim() ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`${name} must be a valid GitHub repository coordinate`);
  }
}

function assertBranchRef(value: string): void {
  const parts = value.split('/');
  if (
    value === '' ||
    value !== value.trim() ||
    value.includes('\\') ||
    hasControlCharacter(value) ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError('branch must be a valid Git ref');
  }
}

function mirrorBase(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.search || url.hash) {
    throw new TypeError('mirror must be an http(s) URL without a query or fragment');
  }
  return url.href.replace(/\/+$/, '');
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

function isSecondaryRateLimitMessage(value: unknown): boolean {
  if (!isRecord(value) || typeof value.message !== 'string') return false;
  const message = value.message.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    /\b(?:exceeded|hit|triggered) (?:a |the )?secondary rate limit\b/.test(message) ||
    /\bsecondary rate limit (?:was |has been )?(?:exceeded|hit|triggered)\b/.test(message)
  );
}

async function isTransientResponse(response: Response): Promise<boolean> {
  if (isTransientStatus(response.status)) return true;
  if (response.status !== 403) return false;
  if (
    response.headers.get('x-ratelimit-remaining') === '0' ||
    response.headers.get('retry-after') !== null
  ) {
    return true;
  }
  try {
    return isSecondaryRateLimitMessage(await response.clone().json());
  } catch {
    return false;
  }
}

function reject(error: unknown): Promise<never> {
  return Promise.reject(
    error instanceof Error ? error : new Error('Operation failed with a non-error value'),
  );
}

function cancelUnusedResponseBody(response: Response | undefined): void {
  try {
    if (!response || response.bodyUsed) return;
    const body = response.body;
    if (!body) return;
    void body.cancel().catch(() => undefined);
  } catch {
    // Cleanup must not override the request result.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGitHubItem(value: unknown): value is GitHubItem {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.path === 'string' &&
    typeof value.type === 'string'
  );
}

function isGitHubTreeItem(value: unknown): value is GitHubTreeItem {
  return isRecord(value) && typeof value.path === 'string' && typeof value.type === 'string';
}

function parseContentsResponse(value: unknown): GitHubItem[] {
  if (!Array.isArray(value) || !value.every(isGitHubItem)) {
    throw new TypeError('Invalid GitHub contents response');
  }
  return value;
}

function parseTreeResponse(value: unknown): GitHubTreeResponse {
  if (
    !isRecord(value) ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.tree) ||
    !value.tree.every(isGitHubTreeItem)
  ) {
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
  const token =
    options.token ??
    (typeof process !== 'undefined'
      ? (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)
      : undefined);
  const apiRepoUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const rawRepoUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const encodedBranch = encodeURIComponent(branch);
  const mirror = mirrorBase(options.mirror);
  let mirrorFailed = false;
  const dirTtlMs = cacheTtl(options.cacheTtlMs?.dir, DEFAULTS.dirTtlMs, 'cacheTtlMs.dir');
  const fileTtlMs = cacheTtl(options.cacheTtlMs?.file, DEFAULTS.fileTtlMs, 'cacheTtlMs.file');

  const dirCache = new TtlCache<DocItem[]>(dirTtlMs, 30);
  const fileCache = new TtlCache<string>(fileTtlMs, 200);
  const treeCache = new TtlCache<DocItem[]>(dirTtlMs, 1);
  const dirRequests = new Map<string, Promise<DocItem[]>>();
  const fileRequests = new Map<string, Promise<string>>();
  const treeRequests = new Map<string, Promise<DocItem[]>>();
  const store = options.store;
  let storedTree: DocItem[] | undefined;
  let cacheGeneration = 0;

  function storeRead(key: string): string | undefined {
    try {
      return store?.read(key);
    } catch {
      return undefined;
    }
  }

  function storeWrite(key: string, value: string): void {
    try {
      store?.write(key, value);
    } catch {
      return;
    }
  }

  function knownTree(): DocItem[] | undefined {
    const fetched = treeCache.getStale(TREE_KEY);
    if (fetched) return fetched;
    storedTree ??= parseStoredTree(storeRead(TREE_KEY));
    return storedTree;
  }

  function headers(): Record<string, string> {
    const requestHeaders: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
    };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    return requestHeaders;
  }

  async function withResponse<T>(
    url: string,
    timeoutMs: number,
    consume: (response: Response) => Promise<T>,
    requestHeaders = headers(),
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
    }, timeoutMs);
    let response: Response | undefined;
    try {
      response = await fetch(url, { signal: ctrl.signal, headers: requestHeaders });
      return await consume(response);
    } finally {
      clearTimeout(timer);
      // Not awaited: a custom transport's cancel may never settle.
      cancelUnusedResponseBody(response);
    }
  }

  async function fromMirror<T>(
    base: string,
    path: string,
    read: (response: Response) => Promise<T | undefined>,
  ): Promise<T | undefined> {
    if (mirrorFailed) return undefined;
    try {
      return await withResponse(
        `${base}/${path}`,
        MIRROR_TIMEOUT_MS,
        async (response) => {
          if (response.status >= 500) mirrorFailed = true;
          return response.ok ? await read(response) : undefined;
        },
        {},
      );
    } catch {
      mirrorFailed = true;
      return undefined;
    }
  }

  function keepTree(items: DocItem[], generation: number): DocItem[] {
    if (generation === cacheGeneration) {
      treeCache.set(TREE_KEY, copyItems(items));
      if (store) storeWrite(TREE_KEY, JSON.stringify(items));
    }
    return items;
  }

  async function keepFile(path: string, content: string, generation: number): Promise<string> {
    if (generation === cacheGeneration) fileCache.set(path, content);
    if (store) storeWrite(`blob-${await blobSha(content)}`, content);
    return content;
  }

  function recoverFailure<T>(
    cache: TtlCache<T>,
    key: string,
    path: string,
    error: unknown,
    copy: (value: T) => T = (value) => value,
  ): T {
    const stale = cache.getStale(key);
    if (stale !== undefined) return copy(stale);
    const message =
      error instanceof Error && error.name === 'AbortError' ? 'Request timed out' : String(error);
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

  async function loadDir(path: string, generation: number): Promise<DocItem[]> {
    const url = `${apiRepoUrl}/contents/${encodePath(path)}?ref=${encodedBranch}`;
    try {
      return await withResponse(url, 10_000, async (response) => {
        if (!response.ok) {
          const stale = dirCache.getStale(path);
          if (stale !== undefined && (await isTransientResponse(response))) return copyItems(stale);
          throw new DocsFetchError(path, response.status, `HTTP ${String(response.status)}`);
        }
        const data = parseContentsResponse(await response.json());
        const items = filterAndSort(data);
        if (generation === cacheGeneration) dirCache.set(path, copyItems(items));
        return items;
      });
    } catch (error) {
      if (error instanceof DocsFetchError) throw error;
      return recoverFailure(dirCache, path, path, error, copyItems);
    }
  }

  function listDir(path = ''): Promise<DocItem[]> {
    try {
      assertRepositoryPath(path, true);
    } catch (error) {
      return reject(error);
    }
    const hit = dirCache.get(path);
    if (hit) return Promise.resolve(copyItems(hit));
    return shareRequest(dirRequests, path, () => loadDir(path, cacheGeneration)).then(copyItems);
  }

  async function loadAll(generation: number): Promise<DocItem[]> {
    const key = TREE_KEY;
    if (mirror !== undefined) {
      const mirrored = await fromMirror(mirror, 'index.json', async (response) => {
        const data = parseTreeResponse(await response.json());
        return data.truncated ? undefined : filterTree(data.tree);
      });
      if (mirrored) return keepTree(mirrored, generation);
    }
    const url = `${apiRepoUrl}/git/trees/${encodedBranch}?recursive=1`;
    try {
      return await withResponse(url, 20_000, async (response) => {
        if (!response.ok) {
          const stale = treeCache.getStale(key);
          if (stale !== undefined && (await isTransientResponse(response))) return copyItems(stale);
          throw new DocsFetchError('', response.status, `HTTP ${String(response.status)}`);
        }
        const data = parseTreeResponse(await response.json());
        if (data.truncated) {
          const stale = treeCache.getStale(key);
          if (stale !== undefined) return copyItems(stale);
          throw new DocsFetchError(
            '',
            null,
            'GitHub truncated the repository tree (too many files) -- results would be incomplete',
          );
        }
        return keepTree(filterTree(data.tree), generation);
      });
    } catch (error) {
      if (error instanceof DocsFetchError) throw error;
      return recoverFailure(treeCache, key, '', error, copyItems);
    }
  }

  function listAll(): Promise<DocItem[]> {
    const hit = treeCache.get(TREE_KEY);
    if (hit) return Promise.resolve(copyItems(hit));
    return shareRequest(treeRequests, TREE_KEY, () => loadAll(cacheGeneration)).then(copyItems);
  }

  function peekAll(): DocItem[] | undefined {
    const items = knownTree();
    return items && copyItems(items);
  }

  async function listSections(): Promise<DocSection[]> {
    return sectionsFromItems(await listAll());
  }

  async function loadStoredFile(path: string): Promise<string | undefined> {
    const sha = knownTree()?.find((item) => item.path === path)?.sha;
    if (sha === undefined) return undefined;
    const content = storeRead(`blob-${sha}`);
    return content !== undefined && (await blobSha(content)) === sha ? content : undefined;
  }

  async function loadFile(path: string, generation: number): Promise<string> {
    const stored = store && (await loadStoredFile(path));
    if (stored !== undefined) {
      if (generation === cacheGeneration) fileCache.set(path, stored);
      return stored;
    }
    if (mirror !== undefined) {
      const mirrored = await fromMirror(mirror, `raw/${encodePath(path)}`, (response) =>
        response.text(),
      );
      if (mirrored !== undefined) return keepFile(path, mirrored, generation);
    }
    const url = `${rawRepoUrl}/${encodedBranch}/${encodePath(path)}`;
    try {
      return await withResponse(url, 15_000, async (response) => {
        if (!response.ok) {
          const stale = fileCache.getStale(path);
          if (stale !== undefined && (await isTransientResponse(response))) return stale;
          throw new DocsFetchError(path, response.status, `HTTP ${String(response.status)}`);
        }
        return keepFile(path, await response.text(), generation);
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
      return reject(error);
    }
    const hit = fileCache.get(path);
    if (hit !== undefined) return Promise.resolve(hit);
    return shareRequest(fileRequests, path, () => loadFile(path, cacheGeneration));
  }

  async function getDocument(path: string): Promise<DocPage> {
    if (!path.toLowerCase().endsWith('.md')) {
      throw new TypeError('path must point to a Markdown document');
    }
    return parseDoc(path, await getFile(path));
  }

  async function search(
    query: string,
    options: DocsSearchOptions = {},
  ): Promise<DocsSearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new TypeError('query must not be empty');
    const limit = searchLimit(options.limit);
    const pathPrefix = options.pathPrefix ?? '';
    assertRepositoryPath(pathPrefix, true);
    if (limit === 0) return [];
    const all = await listAll();
    const candidates = pathPrefix
      ? all.filter((item) => item.path.startsWith(`${pathPrefix}/`))
      : all;
    let loaded = 0;
    let firstFailure: DocsFetchError | undefined;
    const matches = await mapConcurrent(candidates, SEARCH_CONCURRENCY, async (item) => {
      try {
        const document = await getDocument(item.path);
        loaded += 1;
        return searchDoc(document, normalizedQuery);
      } catch (error) {
        if (error instanceof DocsFetchError) {
          firstFailure ??= error;
          return null;
        }
        throw error;
      }
    });
    if (loaded === 0 && firstFailure) throw firstFailure;
    return matches
      .filter((result): result is DocsSearchResult => result !== null)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, limit);
  }

  function clear(): void {
    cacheGeneration += 1;
    storedTree = undefined;
    dirCache.clear();
    fileCache.clear();
    treeCache.clear();
    dirRequests.clear();
    fileRequests.clear();
    treeRequests.clear();
  }

  return { listDir, listAll, peekAll, listSections, getFile, getDocument, search, clear };
}
