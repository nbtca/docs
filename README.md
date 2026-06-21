# @nbtca/docs

Data-only library for the [NBTCA documents repository](https://github.com/nbtca/documents).
Fetches directory listings and raw markdown files from GitHub with built-in TTL caching,
stale-while-revalidate fallback, and rate-limit handling.

Rendering is the consumer's job (e.g. `@nbtca/prompt`).

## Install

```bash
npm install @nbtca/docs
```

## Usage

```ts
import { createDocsClient } from '@nbtca/docs';

const docs = createDocsClient(); // defaults to nbtca/documents@main

const items = await docs.listDir('tutorial');  // DocItem[]
const md    = await docs.getFile('repair/guide.md');  // string (raw markdown)
```

Custom target:

```ts
const docs = createDocsClient({
  owner: 'my-org',
  repo: 'my-docs',
  branch: 'main',
  token: process.env.GITHUB_TOKEN,
});
```

## API

### `createDocsClient(options?)`

| Option | Default | Description |
|---|---|---|
| `owner` | `'nbtca'` | GitHub org/user |
| `repo` | `'documents'` | Repository name |
| `branch` | `'main'` | Branch or ref |
| `token` | `GITHUB_TOKEN` env | Auth token (raises rate limit) |
| `cacheTtlMs.dir` | `300000` (5 min) | Directory listing cache TTL |
| `cacheTtlMs.file` | `600000` (10 min) | File content cache TTL |

### `docs.listDir(path?)`

Returns `DocItem[]` for the given path (root if omitted).
Filters out hidden files, non-markdown files, and repository metadata.

### `docs.getFile(path)`

Returns raw markdown as a string. Falls back to stale cache on network error.

### `DocsFetchError`

Thrown when a fetch fails with no stale cache available. Has `.path` and `.status` fields.

## License

MIT
