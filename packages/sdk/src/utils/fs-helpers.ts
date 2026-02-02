/**
 * Filesystem Helpers
 * 
 * Shared filesystem utilities for workspace and environment management.
 */

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Cleans up stale directories that are not in the active set.
 * 
 * Used by both EnvironmentBuilder (delegator) and WorkspaceManager (executor)
 * to remove directories from previous runs that were not properly cleaned up.
 * 
 * @param baseDir - Root directory containing subdirectories to check
 * @param activeIds - Set of delegation IDs that should be preserved
 * @returns Number of directories cleaned up
 */
export async function cleanupStaleDirectories(
  baseDir: string,
  activeIds: Set<string>
): Promise<number> {
  let cleaned = 0;
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !activeIds.has(entry.name)) {
        await rm(join(baseDir, entry.name), { recursive: true, force: true });
        cleaned++;
      }
    }
  } catch {
    // Base directory may not exist yet - this is expected on first run
  }
  return cleaned;
}
