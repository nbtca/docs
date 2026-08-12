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

### `docs.listDir(path?)`

Lists directories and Markdown files at a repository-relative path. The root path is used when
`path` is omitted.

### `docs.getFile(path)`

Returns raw file content.

### `docs.listAll()`

Lists every Markdown file through GitHub's recursive tree API.

### `docs.listSections()`

Returns top-level content sections with document counts and optional index paths.

### `docs.getDocument(path)`

Returns content with its route, section, title, summary, and semantic component attributes. Component
metadata covers `PageHero`, `FactStrip`, `LinkCard`, `Split`, `TimelineEntry`, and `Figure` without
imposing a renderer.

### `docs.search(query, options?)`

Searches paths, titles, summaries, Markdown text, and semantic component attributes. Results are
ranked and include excerpts. Use `pathPrefix` to scope a search and `limit` to cap results.

### `docs.clear()`

Clears all cached values and in-flight request bookkeeping.

### `DocsFetchError`

Thrown when a request fails without usable stale data. Exposes `path` and HTTP `status`.

## License

MIT
