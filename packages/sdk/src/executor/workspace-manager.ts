/**
 * Workspace Manager - manages workspace directories on Executor side
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupStaleDirectories } from '../utils/index.js';

export class WorkspaceManager {
  private workDir: string;
  private allocated = new Set<string>();

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  allocate(delegationId: string): string {
    const path = join(this.workDir, delegationId);
    this.allocated.add(path);
    return path;
  }

  async prepare(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async release(path: string): Promise<void> {
    this.allocated.delete(path);
    try {
      await rm(path, { recursive: true, force: true });
    } catch {
      // Directory may already be removed
    }
  }

  async cleanupStale(knownIds: Set<string>): Promise<number> {
    return cleanupStaleDirectories(this.workDir, knownIds);
  }
}
