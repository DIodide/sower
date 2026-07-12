import type { Platform } from '@sower/core';
import type { PlatformAdapter } from './contract.js';
import { GreenhouseAdapter } from './greenhouse/index.js';

const adapters: Partial<Record<Platform, PlatformAdapter>> = {
  greenhouse: new GreenhouseAdapter(),
};

/** Look up the adapter for a platform. Returns null for platforms without an adapter yet. */
export function getAdapter(platform: Platform): PlatformAdapter | null {
  return adapters[platform] ?? null;
}
