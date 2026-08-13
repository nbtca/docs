import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'nbtca-docs-package-'));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_dry_run: 'false',
      npm_config_fund: 'false',
    },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

try {
  run('npm', ['pack', '--pack-destination', temporaryDirectory], root);
  const tarballs = (await readdir(temporaryDirectory)).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) throw new Error('npm pack did not produce exactly one tarball');

  await writeFile(
    join(temporaryDirectory, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
    }),
  );
  await writeFile(
    join(temporaryDirectory, 'smoke.mjs'),
    [
      "import { createDocsClient, DocsFetchError, parseDoc } from '@nbtca/docs';",
      'const client = createDocsClient();',
      "if (typeof client.listDir !== 'function') throw new TypeError('invalid client export');",
      "if (typeof client.listAll !== 'function') throw new TypeError('invalid tree export');",
      "if (typeof client.listSections !== 'function') throw new TypeError('invalid discovery export');",
      "if (typeof client.getDocument !== 'function') throw new TypeError('invalid document export');",
      "if (typeof client.search !== 'function') throw new TypeError('invalid search export');",
      "if (typeof client.clear !== 'function') throw new TypeError('invalid clear export');",
      'client.clear();',
      "if (parseDoc('index.md', '# Home').title !== 'Home') throw new TypeError('invalid parser export');",
      "if (!(new DocsFetchError('', null, 'test') instanceof Error)) throw new TypeError('invalid error export');",
    ].join('\n'),
  );
  await writeFile(
    join(temporaryDirectory, 'consumer.ts'),
    [
      "import { createDocsClient } from '@nbtca/docs';",
      "import type { DocComponent, DocItem, DocPage, DocSection, DocsClient, DocsClientOptions, DocsSearchOptions, DocsSearchResult } from '@nbtca/docs';",
      "const item = { name: 'guide.md', path: 'repair/guide.md', type: 'file' } satisfies DocItem;",
      "const component = { name: 'Figure', attributes: { caption: 'Example' } } satisfies DocComponent;",
      "const page = { components: [component], content: '# Guide', name: item.name, path: item.path, route: '/repair/guide', section: 'repair', summary: 'Repair guide', title: 'Guide' } satisfies DocPage;",
      "const section = { count: 1, indexPath: 'repair/index.md', path: 'repair' } satisfies DocSection;",
      "const searchOptions = { pathPrefix: 'repair', limit: 10 } satisfies DocsSearchOptions;",
      "const searchResult = { excerpt: 'Repair guide', name: item.name, path: item.path, route: page.route, score: 42, section: page.section, summary: page.summary, title: page.title } satisfies DocsSearchResult;",
      "const options = { branch: 'main', cacheTtlMs: { dir: 0, file: 0 } } satisfies DocsClientOptions;",
      'const client: DocsClient = createDocsClient(options);',
      'async function consumePromptContract(docs: DocsClient): Promise<void> {',
      '  const items: DocItem[] = await docs.listAll();',
      '  const document: DocPage = await docs.getDocument(item.path);',
      "  const results: DocsSearchResult[] = await docs.search('repair', searchOptions);",
      '  docs.clear();',
      '  void items;',
      '  void document;',
      '  void results;',
      '}',
      'void section;',
      'void searchResult;',
      'void client;',
      'void consumePromptContract;',
    ].join('\n'),
  );

  run(
    'npm',
    ['install', '--ignore-scripts', join(temporaryDirectory, tarballs[0])],
    temporaryDirectory,
  );
  run(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'consumer.ts',
    ],
    temporaryDirectory,
  );
  run(process.execPath, ['smoke.mjs'], temporaryDirectory);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
