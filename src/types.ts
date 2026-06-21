export interface DocItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
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
  getFile(path: string): Promise<string>;
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
