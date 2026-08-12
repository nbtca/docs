export interface DocItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
}

export interface DocComponent {
  attributes: Readonly<Record<string, string | true>>;
  name: string;
}

export interface DocPage {
  components: DocComponent[];
  content: string;
  name: string;
  path: string;
  route: string;
  section: string | null;
  summary: string;
  title: string;
}

export interface DocSection {
  count: number;
  indexPath?: string;
  path: string;
}

export interface DocsSearchOptions {
  limit?: number;
  pathPrefix?: string;
}

export interface DocsSearchResult {
  excerpt: string;
  name: string;
  path: string;
  route: string;
  score: number;
  section: string | null;
  summary: string;
  title: string;
}

export interface DocsClientOptions {
  owner?: string;
  repo?: string;
  branch?: string;
  token?: string;
  cacheTtlMs?: {
    dir?: number;
    file?: number;
  };
}

export interface DocsClient {
  listDir(path?: string): Promise<DocItem[]>;
  listAll(): Promise<DocItem[]>;
  listSections(): Promise<DocSection[]>;
  getFile(path: string): Promise<string>;
  getDocument(path: string): Promise<DocPage>;
  search(query: string, options?: DocsSearchOptions): Promise<DocsSearchResult[]>;
  clear(): void;
}

export class DocsFetchError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'DocsFetchError';
  }
}
