import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDocsClient } from '../client.js';
import { DocsFetchError } from '../types.js';

const mockDir = [
  { name: 'repair', path: 'repair', type: 'dir' },
  { name: 'guide.md', path: 'repair/guide.md', type: 'file' },
  { name: 'node_modules', path: 'node_modules', type: 'dir' },
  { name: '.github', path: '.github', type: 'dir' },
  { name: 'image.png', path: 'repair/image.png', type: 'file' },
];

function mockFetch(response: { ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> }) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

beforeEach(() => vi.restoreAllMocks());

describe('createDocsClient', () => {
  it('filters skipped names and non-md files', async () => {
    mockFetch({ ok: true, json: async () => mockDir });
    const client = createDocsClient();
    const items = await client.listDir('repair');
    expect(items.map(i => i.name)).not.toContain('node_modules');
    expect(items.map(i => i.name)).not.toContain('.github');
    expect(items.map(i => i.name)).not.toContain('image.png');
    expect(items.find(i => i.name === 'guide.md')).toBeDefined();
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

  it('getFile caches content', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, text: async () => '# Doc' });
    vi.stubGlobal('fetch', spy);
    const client = createDocsClient();
    await client.getFile('repair/guide.md');
    await client.getFile('repair/guide.md');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
