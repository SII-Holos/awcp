/**
 * Workspace Manager - manages workspace directories on Executor side
 */

import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupStaleDirectories } from '../utils/index.js';

export interface WorkspaceValidation {
  valid: boolean;
  reason?: string;
}

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

  validate(path: string): WorkspaceValidation {
    if (!path.startsWith(this.workDir)) {
      return { valid: false, reason: `Path must be under ${this.workDir}` };
    }
    return { valid: true };
  }

  async prepare(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
    const entries = await readdir(path);
    if (entries.length > 0) {
      throw new Error(`Workspace ${path} is not empty`);
    }
  }

  async release(path: string): Promise<void> {
    this.allocated.delete(path);
    try {
      await rm(path, { recursive: true, force: true });
    } catch {
      // Directory may already be removed
    }
  }

  async cleanupStale(): Promise<number> {
    // Build set of delegation IDs (directory names) that are active
    const activeIds = new Set<string>();
    for (const path of this.allocated) {
      const name = path.substring(this.workDir.length + 1);
      activeIds.add(name);
    }
    return cleanupStaleDirectories(this.workDir, activeIds);
  }

  isAllocated(path: string): boolean {
    return this.allocated.has(path);
  }

  getAllocated(): string[] {
    return Array.from(this.allocated);
  }
}
