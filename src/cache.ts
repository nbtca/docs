interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly map = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSize: number = 50,
  ) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() < entry.expiresAt) return entry.value;
    return undefined;
  }

  getStale(key: string): T | undefined {
    return this.map.get(key)?.value;
  }

  set(key: string, value: T): void {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.map.size > this.maxSize) this.evictOldest();
  }

  clear(): void {
    this.map.clear();
  }

  private evictOldest(): void {
    const oldest = [...this.map.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      .slice(0, this.map.size - this.maxSize);
    for (const [key] of oldest) this.map.delete(key);
  }
}
