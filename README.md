# @nbtca/docs

Typed client for the [NBTCA documents repository](https://github.com/nbtca/documents).
It lists, reads, and searches the Markdown documents, keeps a hash-verified local cache, and
reads from a mirror when GitHub is slow or unreachable. Rendering is up to the consumer.

## Install

```bash
npm install @nbtca/docs
```

## Usage

```ts
import { createDocsClient } from '@nbtca/docs';

const docs = createDocsClient({ mirror: 'https://docs.nbtca.space/docs-api', store });

const sections = await docs.listSections();
const page = await docs.getDocument('repair/index.md');
const matches = await docs.search('repair', { pathPrefix: 'repair', limit: 10 });
```

After a transient failure the client serves stale cached data. With none, it throws
`DocsFetchError`, which exposes `path` and HTTP `status`.

## API

| Method                    | Description                                                                |
| ------------------------- | -------------------------------------------------------------------------- |
| `listSections()`          | Top-level sections with document counts and index paths when present       |
| `listDir(path?)`          | Directories and Markdown files at a path, the root by default              |
| `listAll()`               | Every Markdown file with its Git blob `sha`                                |
| `peekAll()`               | The last known file list without a request, or `undefined`                 |
| `getFile(path)`           | Raw file content                                                           |
| `getDocument(path)`       | Route, section, title, summary, and semantic component attributes          |
| `search(query, options?)` | Ranked results with excerpts; options are `pathPrefix` and `limit`         |
| `prefetch()`              | Loads the whole mirror bundle in one request; resolves to the count loaded |
| `clear()`                 | Drops all cached values and in-flight requests                             |

`parseDoc(path, markdown)` extracts the same metadata as `getDocument` from content you already
have. Component metadata covers `PageHero`, `FactStrip`, `LinkCard`, `Split`, `TimelineEntry`, and
`Figure`.

## Options

| Option            | Default                      | Description                  |
| ----------------- | ---------------------------- | ---------------------------- |
| `mirror`          | none                         | Mirror base URL, see below   |
| `store`           | none                         | Persistent cache, see below  |
| `token`           | `GITHUB_TOKEN` or `GH_TOKEN` | GitHub token                 |
| `owner`           | `'nbtca'`                    | GitHub owner                 |
| `repo`            | `'documents'`                | Repository name              |
| `branch`          | `'main'`                     | Branch name or ref           |
| `cacheTtlMs.dir`  | `300000`                     | Directory and tree cache TTL |
| `cacheTtlMs.file` | `600000`                     | File cache TTL               |

`store` is any object with `read(key): string | undefined` and `write(key, value): void`. The
client writes the file list under `tree` and content under `blob-<sha>`. Stored content is served
only when its hash matches the blob id in the last known tree, so a changed file is always
refetched. Store errors and corrupt entries are ignored; eviction is up to the store.

`mirror` is tried before GitHub. It serves `index.json` in the shape of GitHub's recursive tree
response, each file at `raw/<path>`, and optionally `bundle.json` as
`{ files: [{ path, sha, content }] }`. A search that would fetch many uncached documents loads the
bundle first. Any mirror failure, invalid index, or wait past 5 seconds falls back to GitHub. The
GitHub token is never sent to the mirror.

## License

MIT
