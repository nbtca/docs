import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TtlCache } from '../cache.js';

describe('TtlCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns value before expiry', () => {
    const c = new TtlCache<string>(1000);
    c.set('k', 'v');
    expect(c.get('k')).toBe('v');
  });

  it('returns undefined after expiry', () => {
    const c = new TtlCache<string>(1000);
    c.set('k', 'v');
    vi.advanceTimersByTime(1001);
    expect(c.get('k')).toBeUndefined();
  });

  it('getStale returns expired value', () => {
    const c = new TtlCache<string>(1000);
    c.set('k', 'v');
    vi.advanceTimersByTime(1001);
    expect(c.getStale('k')).toBe('v');
  });

  it('evicts oldest when over maxSize', () => {
    const c = new TtlCache<number>(10_000, 2);
    c.set('a', 1);
    vi.advanceTimersByTime(1);
    c.set('b', 2);
    vi.advanceTimersByTime(1);
    c.set('c', 3); // should evict 'a'
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
  });

  it('clear removes all entries', () => {
    const c = new TtlCache<string>(10_000);
    c.set('k', 'v');
    c.clear();
    expect(c.get('k')).toBeUndefined();
    expect(c.getStale('k')).toBeUndefined();
  });
});
