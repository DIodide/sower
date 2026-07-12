import { describe, expect, it } from 'vitest';
import { AshbyAdapter } from './ashby/index.js';
import { GreenhouseAdapter } from './greenhouse/index.js';
import { LeverAdapter } from './lever/index.js';
import { getAdapter } from './registry.js';

describe('getAdapter', () => {
  it('returns the greenhouse adapter', () => {
    expect(getAdapter('greenhouse')).toBeInstanceOf(GreenhouseAdapter);
  });

  it('returns the ashby adapter', () => {
    expect(getAdapter('ashby')).toBeInstanceOf(AshbyAdapter);
  });

  it('returns the lever adapter', () => {
    expect(getAdapter('lever')).toBeInstanceOf(LeverAdapter);
  });

  it('returns null for platforms without an adapter', () => {
    expect(getAdapter('workday')).toBeNull();
    expect(getAdapter('unknown')).toBeNull();
  });

  it('every registered adapter reports its own platform', () => {
    for (const platform of ['greenhouse', 'ashby', 'lever'] as const) {
      expect(getAdapter(platform)?.platform).toBe(platform);
    }
  });
});
