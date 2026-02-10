import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Assignment } from '@awcp/core';

export interface AssignmentManagerConfig {
  baseDir: string;
}

export class AssignmentManager {
  private baseDir: string;

  constructor(config: AssignmentManagerConfig) {
    this.baseDir = config.baseDir;
  }

  async save(assignment: Assignment): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    const filePath = join(this.baseDir, `${assignment.id}.json`);
    await writeFile(filePath, JSON.stringify(assignment, null, 2));
  }

  async load(assignmentId: string): Promise<Assignment | undefined> {
    try {
      const filePath = join(this.baseDir, `${assignmentId}.json`);
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as Assignment;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async loadAll(): Promise<Assignment[]> {
    try {
      const entries = await readdir(this.baseDir);
      const assignments: Assignment[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const content = await readFile(join(this.baseDir, entry), 'utf-8');
        assignments.push(JSON.parse(content) as Assignment);
      }
      return assignments;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async delete(assignmentId: string): Promise<void> {
    const filePath = join(this.baseDir, `${assignmentId}.json`);
    await rm(filePath, { force: true });
  }
}
