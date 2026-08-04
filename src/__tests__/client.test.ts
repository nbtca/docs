import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDocsClient } from '../client.js';
import { DocsFetchError } from '../types.js';

const mockDir = [
  { name: 'repair', path: 'repair', type: 'dir' },
  { name: 'guide.md', path: 'repair/guide.md', type: 'file' },
  { name: 'node_modules', path: 'node_modules', type: 'dir' },
  { name: '.github', path: '.github', type: 'dir' },
  { name: 'image.png', path: 'repair/image.png', type: 'file' },
];

const mockTree = {
  truncated: false,
  tree: [
    { path: 'repair/guide.md',     type: 'blob' },
    { path: 'repair/advanced.md',  type: 'blob' },
    { path: 'repair',              type: 'tree' },
    { path: 'repair/image.png',    type: 'blob' },
    { path: 'node_modules/pkg.md', type: 'blob' },
    { path: '.github/CODEOWNERS',  type: 'blob' },
    { path: 'CONTRIBUTING.md',     type: 'blob' },
    { path: '.hidden/secret.md',   type: 'blob' },
    { path: 'intro.md',            type: 'blob' },
  ],
};

function mockFetch(response: { ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> }) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

function mockFetchThenFail(first: { ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> }, error: Error) {
  const fn = vi.fn()
    .mockResolvedValueOnce(first)
    .mockRejectedValue(error);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => vi.restoreAllMocks());

describe('createDocsClient', () => {
  it.each([
    { owner: '' },
    { owner: '..' },
    { owner: 'nbtca/other' },
    { repo: '.' },
    { branch: '' },
    { branch: '..' },
  ])('rejects invalid repository coordinates: %o', options => {
    expect(() => createDocsClient(options)).toThrow(TypeError);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid cache TTL: %s',
    ttl => {
      expect(() => createDocsClient({ cacheTtlMs: { dir: ttl } })).toThrow(RangeError);
      expect(() => createDocsClient({ cacheTtlMs: { file: ttl } })).toThrow(RangeError);
    },
  );

  it('filters skipped names and non-md files', async () => {
    mockFetch({ ok: true, json: async () => mockDir });
    const client = createDocsClient();
    const items = await client.listDir('repair');
    expect(items.map(i => i.name)).not.toContain('node_modules');
    expect(items.map(i => i.name)).not.toContain('.github');
    expect(items.map(i => i.name)).not.toContain('image.png');
    expect(items.find(i => i.name === 'guide.md')).toBeDefined();
  });

  it('does not expose symlinks or submodules as document files', async () => {
    mockFetch({
      ok: true,
      json: async () => [
        { name: 'linked.md', path: 'linked.md', type: 'symlink' },
        { name: 'module.md', path: 'module.md', type: 'submodule' },
      ],
    });
    await expect(createDocsClient().listDir()).resolves.toEqual([]);
  });

  it('sorts dirs before files', async () => {
    mockFetch({ ok: true, json: async () => mockDir });
    const client = createDocsClient();
    const items = await client.listDir();
    const types = items.map(i => i.type);
    const firstFile = types.indexOf('file');
    const lastDir = types.lastIndexOf('dir');
    expect(lastDir).toBeLessThan(firstFile === -1 ? Infinity : firstFile);
  });

  it('caches directory results', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', spy);
    const client = createDocsClient();
    await client.listDir('tutorial');
    await client.listDir('tutorial');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not let callers mutate a cached directory result', async () => {
    mockFetch({ ok: true, json: async () => mockDir });
    const client = createDocsClient();
    const first = await client.listDir('repair');
    first.splice(0, first.length);
    const second = await client.listDir('repair');
    expect(second.length).toBeGreaterThan(0);
  });

  it('keeps the root cache separate from a directory named __root__', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: 'root.md', path: 'root.md', type: 'file' }],
      })
      .mockResolvedValue({
        ok: true,
        json: async () => [{ name: 'nested.md', path: '__root__/nested.md', type: 'file' }],
      });
    vi.stubGlobal('fetch', fetchMock);
    const client = createDocsClient();
    await expect(client.listDir()).resolves.toMatchObject([{ name: 'root.md' }]);
    await expect(client.listDir('__root__')).resolves.toMatchObject([{ name: 'nested.md' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws DocsFetchError on HTTP error', async () => {
    mockFetch({ ok: false, status: 404 });
    const client = createDocsClient();
    await expect(client.listDir('nonexistent')).rejects.toBeInstanceOf(DocsFetchError);
  });

  it('getFile fetches raw content', async () => {
    mockFetch({ ok: true, text: async () => '# Hello' });
    const client = createDocsClient();
    const content = await client.getFile('repair/guide.md');
    expect(content).toBe('# Hello');
  });

  it('encodes directory paths and branch refs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    const client = createDocsClient({ branch: 'feature/docs' });
    await client.listDir('repair/# urgent?');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/nbtca/documents/contents/repair/%23%20urgent%3F?ref=feature%2Fdocs',
      expect.any(Object),
    );
  });

  it('encodes tree refs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockTree });
    vi.stubGlobal('fetch', fetchMock);
    const client = createDocsClient({ branch: 'feature/docs' });
    await client.listAll();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/nbtca/documents/git/trees/feature%2Fdocs?recursive=1',
      expect.any(Object),
    );
  });

  it('encodes raw file paths and branch refs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '# Hello' });
    vi.stubGlobal('fetch', fetchMock);
    const client = createDocsClient({ branch: 'feature/docs' });
    await client.getFile('repair/# urgent?.md');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/nbtca/documents/feature%2Fdocs/repair/%23%20urgent%3F.md',
      expect.any(Object),
    );
  });

  it('rejects paths that can escape the repository endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = createDocsClient();
    await expect(client.listDir('../issues')).rejects.toBeInstanceOf(TypeError);
    await expect(client.getFile('/README.md')).rejects.toBeInstanceOf(TypeError);
    await expect(client.getFile('repair\\..\\README.md')).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getFile caches content', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, text: async () => '# Doc' });
    vi.stubGlobal('fetch', spy);
    const client = createDocsClient();
    await client.getFile('repair/guide.md');
    await client.getFile('repair/guide.md');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('getFile caches empty content', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', spy);
    const client = createDocsClient();
    await client.getFile('empty.md');
    await client.getFile('empty.md');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe('stale-while-revalidate fallback (README\'s headline resilience claim, previously untested)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('listDir returns the last-known-good listing when a refetch throws (network error)', async () => {
      mockFetchThenFail({ ok: true, json: async () => mockDir }, new Error('network down'));
      const client = createDocsClient({ cacheTtlMs: { dir: 1000 } });
      const fresh = await client.listDir('repair');
      vi.advanceTimersByTime(1001);
      const stale = await client.listDir('repair');
      expect(stale).toEqual(fresh);
    });

    it('listDir still throws DocsFetchError when a refetch fails and there is no cache at all', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      const client = createDocsClient();
      await expect(client.listDir('never-fetched')).rejects.toBeInstanceOf(DocsFetchError);
    });

    it('listDir returns stale data when a refetch responds with an HTTP error (not just a thrown network error)', async () => {
      const fn = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => mockDir })
        .mockResolvedValue({ ok: false, status: 503 });
      vi.stubGlobal('fetch', fn);
      const client = createDocsClient({ cacheTtlMs: { dir: 1000 } });
      const fresh = await client.listDir('repair');
      vi.advanceTimersByTime(1001);
      const stale = await client.listDir('repair');
      expect(stale).toEqual(fresh);
    });

    it('does not hide a permanent HTTP error behind stale data', async () => {
      const fn = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => mockDir })
        .mockResolvedValue({ ok: false, status: 404 });
      vi.stubGlobal('fetch', fn);
      const client = createDocsClient({ cacheTtlMs: { dir: 1000 } });
      await client.listDir('repair');
      vi.advanceTimersByTime(1001);
      await expect(client.listDir('repair')).rejects.toMatchObject({ status: 404 });
    });

    it('getFile returns the last-known-good content when a refetch throws', async () => {
      mockFetchThenFail({ ok: true, text: async () => '# Hello' }, new Error('network down'));
      const client = createDocsClient({ cacheTtlMs: { file: 1000 } });
      const fresh = await client.getFile('repair/guide.md');
      vi.advanceTimersByTime(1001);
      const stale = await client.getFile('repair/guide.md');
      expect(stale).toBe(fresh);
    });

    it('getFile returns stale empty content when a refetch throws', async () => {
      mockFetchThenFail({ ok: true, text: async () => '' }, new Error('network down'));
      const client = createDocsClient({ cacheTtlMs: { file: 1000 } });
      await client.getFile('empty.md');
      vi.advanceTimersByTime(1001);
      await expect(client.getFile('empty.md')).resolves.toBe('');
    });

    it('listAll returns the last-known-good tree when a refetch throws', async () => {
      mockFetchThenFail({ ok: true, json: async () => mockTree }, new Error('network down'));
      const client = createDocsClient({ cacheTtlMs: { dir: 1000 } });
      const fresh = await client.listAll();
      vi.advanceTimersByTime(1001);
      const stale = await client.listAll();
      expect(stale).toEqual(fresh);
    });

    it('listDir returns stale data when reading a successful response fails', async () => {
      const fn = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => mockDir })
        .mockResolvedValue({ ok: true, json: async () => { throw new Error('invalid JSON'); } });
      vi.stubGlobal('fetch', fn);
      const client = createDocsClient({ cacheTtlMs: { dir: 1000 } });
      const fresh = await client.listDir('repair');
      vi.advanceTimersByTime(1001);
      await expect(client.listDir('repair')).resolves.toEqual(fresh);
    });

    it('listAll returns stale data when reading a successful response fails', async () => {
      const fn = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => mockTree })
        .mockResolvedValue({ ok: true, json: async () => { throw new Error('invalid JSON'); } });
      vi.stubGlobal('fetch', fn);
      const client = createDocsClient({ cacheTtlMs: { dir: 1000 } });
      const fresh = await client.listAll();
      vi.advanceTimersByTime(1001);
      await expect(client.listAll()).resolves.toEqual(fresh);
    });

    it('listDir returns stale data when a successful response has the wrong shape', async () => {
      const fn = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => mockDir })
        .mockResolvedValue({ ok: true, json: async () => ({ message: 'unexpected' }) });
      vi.stubGlobal('fetch', fn);
      const client = createDocsClient({ cacheTtlMs: { dir: 1000 } });
      const fresh = await client.listDir('repair');
      vi.advanceTimersByTime(1001);
      await expect(client.listDir('repair')).resolves.toEqual(fresh);
    });

    it('listAll returns stale data when a successful response has the wrong shape', async () => {
      const fn = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => mockTree })
        .mockResolvedValue({ ok: true, json: async () => ({ truncated: false, tree: null }) });
      vi.stubGlobal('fetch', fn);
      const client = createDocsClient({ cacheTtlMs: { dir: 1000 } });
      const fresh = await client.listAll();
      vi.advanceTimersByTime(1001);
      await expect(client.listAll()).resolves.toEqual(fresh);
    });

    it('getFile returns stale data when reading a successful response fails', async () => {
      const fn = vi.fn()
        .mockResolvedValueOnce({ ok: true, text: async () => '# Hello' })
        .mockResolvedValue({ ok: true, text: async () => { throw new Error('stream closed'); } });
      vi.stubGlobal('fetch', fn);
      const client = createDocsClient({ cacheTtlMs: { file: 1000 } });
      const fresh = await client.getFile('repair/guide.md');
      vi.advanceTimersByTime(1001);
      await expect(client.getFile('repair/guide.md')).resolves.toBe(fresh);
    });

    it('wraps response body failures when no stale data exists', async () => {
      mockFetch({ ok: true, json: async () => { throw new Error('invalid JSON'); } });
      const client = createDocsClient();
      await expect(client.listDir('broken')).rejects.toMatchObject({
        name: 'DocsFetchError',
        path: 'broken',
        status: null,
      });
    });

    it('wraps invalid response shapes when no stale data exists', async () => {
      mockFetch({ ok: true, json: async () => ({ message: 'unexpected' }) });
      const client = createDocsClient();
      await expect(client.listDir('broken')).rejects.toBeInstanceOf(DocsFetchError);
    });
  });

  describe('clear', () => {
    it('does not cache a directory response started before clear', async () => {
      const pending = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
      const fetchMock = vi.fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue({ ok: true, json: async () => [{ name: 'new.md', path: 'new.md', type: 'file' }] });
      vi.stubGlobal('fetch', fetchMock);
      const client = createDocsClient();
      const first = client.listDir();
      client.clear();
      pending.resolve({ ok: true, json: async () => [{ name: 'old.md', path: 'old.md', type: 'file' }] });
      await expect(first).resolves.toMatchObject([{ name: 'old.md' }]);
      await expect(client.listDir()).resolves.toMatchObject([{ name: 'new.md' }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not cache a tree response started before clear', async () => {
      const pending = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
      const fetchMock = vi.fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue({
          ok: true,
          json: async () => ({ truncated: false, tree: [{ path: 'new.md', type: 'blob' }] }),
        });
      vi.stubGlobal('fetch', fetchMock);
      const client = createDocsClient();
      const first = client.listAll();
      client.clear();
      pending.resolve({
        ok: true,
        json: async () => ({ truncated: false, tree: [{ path: 'old.md', type: 'blob' }] }),
      });
      await expect(first).resolves.toMatchObject([{ name: 'old.md' }]);
      await expect(client.listAll()).resolves.toMatchObject([{ name: 'new.md' }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not cache file content started before clear', async () => {
      const pending = deferred<{ ok: boolean; text: () => Promise<string> }>();
      const fetchMock = vi.fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue({ ok: true, text: async () => 'new' });
      vi.stubGlobal('fetch', fetchMock);
      const client = createDocsClient();
      const first = client.getFile('guide.md');
      client.clear();
      const refreshed = client.getFile('guide.md');
      pending.resolve({ ok: true, text: async () => 'old' });
      await expect(first).resolves.toBe('old');
      await expect(refreshed).resolves.toBe('new');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrent requests', () => {
    it('shares an in-flight directory request for the same path', async () => {
      const pending = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
      const fetchMock = vi.fn().mockImplementation(() => pending.promise);
      vi.stubGlobal('fetch', fetchMock);
      const client = createDocsClient();
      const first = client.listDir('repair');
      const second = client.listDir('repair');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      pending.resolve({ ok: true, json: async () => mockDir });
      const [a, b] = await Promise.all([first, second]);
      expect(b).toEqual(a);
    });

    it('shares the in-flight tree request', async () => {
      const pending = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
      const fetchMock = vi.fn().mockImplementation(() => pending.promise);
      vi.stubGlobal('fetch', fetchMock);
      const client = createDocsClient();
      const first = client.listAll();
      const second = client.listAll();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      pending.resolve({ ok: true, json: async () => mockTree });
      const [a, b] = await Promise.all([first, second]);
      expect(b).toEqual(a);
    });

    it('shares an in-flight file request for the same path', async () => {
      const pending = deferred<{ ok: boolean; text: () => Promise<string> }>();
      const fetchMock = vi.fn().mockImplementation(() => pending.promise);
      vi.stubGlobal('fetch', fetchMock);
      const client = createDocsClient();
      const first = client.getFile('guide.md');
      const second = client.getFile('guide.md');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      pending.resolve({ ok: true, text: async () => '# Guide' });
      const [a, b] = await Promise.all([first, second]);
      expect(b).toBe(a);
    });

    it('retries after a shared request fails', async () => {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValue({ ok: true, text: async () => '# Guide' });
      vi.stubGlobal('fetch', fetchMock);
      const client = createDocsClient();
      const failed = await Promise.allSettled([
        client.getFile('guide.md'),
        client.getFile('guide.md'),
      ]);
      expect(failed.every(result => result.status === 'rejected')).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(client.getFile('guide.md')).resolves.toBe('# Guide');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('timeouts', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('keeps the timeout active while reading a response body', async () => {
      let signal!: AbortSignal;
      const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return Promise.resolve({
          ok: true,
          json: () => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            }, { once: true });
          }),
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      const client = createDocsClient();
      const request = client.listDir();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(signal.aborted).toBe(true);
      await expect(request).rejects.toMatchObject({
        name: 'DocsFetchError',
        path: '',
        status: null,
        message: 'Request timed out',
      });
    });
  });
});

describe('listAll', () => {
  it('returns only .md blobs, sorted by path', async () => {
    mockFetch({ ok: true, json: async () => mockTree });
    const client = createDocsClient();
    const items = await client.listAll();
    const paths = items.map(i => i.path);
    expect(paths).toEqual(['intro.md', 'repair/advanced.md', 'repair/guide.md']);
  });

  it('filters skipped paths and hidden segments', async () => {
    mockFetch({ ok: true, json: async () => mockTree });
    const client = createDocsClient();
    const items = await client.listAll();
    const paths = items.map(i => i.path);
    expect(paths).not.toContain('node_modules/pkg.md');
    expect(paths).not.toContain('.hidden/secret.md');
    expect(paths).not.toContain('CONTRIBUTING.md');
    expect(paths).not.toContain('repair/image.png');
  });

  it('returns file type for all items', async () => {
    mockFetch({ ok: true, json: async () => mockTree });
    const client = createDocsClient();
    const items = await client.listAll();
    expect(items.every(i => i.type === 'file')).toBe(true);
  });

  it('caches tree results', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => mockTree });
    vi.stubGlobal('fetch', spy);
    const client = createDocsClient();
    await client.listAll();
    await client.listAll();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('throws DocsFetchError on HTTP error', async () => {
    mockFetch({ ok: false, status: 500 });
    const client = createDocsClient();
    await expect(client.listAll()).rejects.toBeInstanceOf(DocsFetchError);
  });
});
