# @nbtca/docs

Typed GitHub client for the [NBTCA documents repository](https://github.com/nbtca/documents).
It lists Markdown documents, reads raw content, caches successful responses, and falls back to
stale data after transient failures. Rendering remains the consumer's responsibility.

## Install

```bash
npm install @nbtca/docs
```

## Usage

```ts
import { createDocsClient } from '@nbtca/docs';

const docs = createDocsClient();

const sections = await docs.listDir();
const documents = await docs.listAll();
const markdown = await docs.getFile('repair/guide.md');
const page = await docs.getDocument('repair/index.md');
const matches = await docs.search('repair', { pathPrefix: 'repair' });
```

## API

### `createDocsClient(options?)`

| Option            | Default                      | Description                  |
| ----------------- | ---------------------------- | ---------------------------- |
| `owner`           | `'nbtca'`                    | GitHub owner                 |
| `repo`            | `'documents'`                | Repository name              |
| `branch`          | `'main'`                     | Branch name or ref           |
| `token`           | `GITHUB_TOKEN` or `GH_TOKEN` | GitHub token                 |
| `cacheTtlMs.dir`  | `300000`                     | Directory and tree cache TTL |
| `cacheTtlMs.file` | `600000`                     | File cache TTL               |
| `store`           | none                         | Persistent cache, see below  |
| `mirror`          | none                         | Mirror base URL, see below   |

### `docs.listDir(path?)`

Lists directories and Markdown files at a repository-relative path. The root path is used when
`path` is omitted.

### `docs.getFile(path)`

Returns raw file content.

### `docs.listAll()`

Lists every Markdown file through GitHub's recursive tree API. Each item carries its Git blob `sha`.

### `docs.peekAll()`

Returns the last known tree without a request: the one fetched in this process, else the one in
`store`, else `undefined`.

### `docs.listSections()`

Returns top-level content sections with document counts and optional index paths.

### `docs.getDocument(path)`

Returns content with its route, section, title, summary, and semantic component attributes. Component
metadata covers `PageHero`, `FactStrip`, `LinkCard`, `Split`, `TimelineEntry`, and `Figure` without
imposing a renderer.

### `store`

An object with `read(key): string | undefined` and `write(key, value): void`. The client keeps the
tree under `tree` and file content under `blob-<sha>`, where `<sha>` is the Git blob id. `getFile`
serves stored content only when its hash matches the blob id in the last known tree, so a changed
file is always refetched. Store errors and corrupt entries are ignored; eviction is up to the store.

### `mirror`

A base URL tried before GitHub by `listAll` and `getFile`, such as
`https://docs.nbtca.space/docs-api`. It serves `index.json` in the shape of GitHub's recursive tree
response, each file at `raw/<path>`, and optionally `bundle.json` as
`{ files: [{ path, sha, content }] }`. Any mirror failure, invalid or truncated index, or wait past
5 seconds falls back to GitHub. The GitHub token is never sent to the mirror.

### `docs.prefetch()`

Loads every document from the mirror's `bundle.json` in one request and resolves to how many were
loaded. Only files whose content hashes to the blob id in the current tree are kept. Resolves to `0`
without a mirror or when the bundle is unavailable.

### `docs.search(query, options?)`

Searches paths, titles, summaries, Markdown text, and semantic component attributes. Results are
ranked and include excerpts. With a mirror, a search that would fetch many uncached documents calls
`prefetch()` first. Use `pathPrefix` to scope a search and `limit` to cap results.

### `docs.clear()`

Clears all cached values and in-flight request bookkeeping.

### `DocsFetchError`

Thrown when a request fails without usable stale data. Exposes `path` and HTTP `status`.

## License

MIT
