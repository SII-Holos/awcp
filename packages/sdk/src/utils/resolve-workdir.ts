/**
 * Work Directory Resolution
 * 
 * Resolves the appropriate working directory from an environment spec.
 * Used by executor agents to determine which resource directory to operate in.
 */

import { join } from 'node:path';
import type { EnvironmentSpec } from '@awcp/core';

export interface WorkDirContext {
  environment: EnvironmentSpec;
  workPath: string;
}

/**
 * Resolves the working directory from environment context.
 * 
 * Resolution order:
 * 1. First read-write resource (primary workspace)
 * 2. Single resource (when only one exists)
 * 3. Environment root (fallback)
 */
export function resolveWorkDir(ctx: WorkDirContext): string {
  const { environment, workPath } = ctx;

  // Prefer the first read-write resource as the primary workspace
  const rwResource = environment.resources.find((r) => r.mode === 'rw');
  if (rwResource) {
    return join(workPath, rwResource.name);
  }

  // Single resource: use it regardless of mode
  if (environment.resources.length === 1) {
    return join(workPath, environment.resources[0]!.name);
  }

  // Fallback to environment root
  return workPath;
}
