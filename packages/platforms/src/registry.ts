import type { Platform } from '@sower/core';
import { AshbyAdapter } from './ashby/index.js';
import type { PlatformAdapter } from './contract.js';
import { GreenhouseAdapter } from './greenhouse/index.js';
import { LeverAdapter } from './lever/index.js';
import { WorkdayAdapter } from './workday/index.js';

const adapters: Partial<Record<Platform, PlatformAdapter>> = {
  greenhouse: new GreenhouseAdapter(),
  ashby: new AshbyAdapter(),
  lever: new LeverAdapter(),
  workday: new WorkdayAdapter(),
};

/** Look up the adapter for a platform. Returns null for platforms without an adapter yet. */
export function getAdapter(platform: Platform): PlatformAdapter | null {
  return adapters[platform] ?? null;
}
