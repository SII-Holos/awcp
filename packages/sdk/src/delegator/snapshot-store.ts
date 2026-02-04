/**
 * Snapshot Store - manages snapshot storage on disk
 */

import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SnapshotStoreConfig {
  baseDir: string;
}

export interface StoredSnapshotMetadata {
  snapshotId: string;
  delegationId: string;
  summary: string;
  highlights?: string[];
  createdAt: string;
  [key: string]: unknown;
}

export class SnapshotStore {
  private baseDir: string;

  constructor(config: SnapshotStoreConfig) {
    this.baseDir = join(config.baseDir, 'delegations');
  }

  async save(
    delegationId: string,
    snapshotId: string,
    snapshotBase64: string,
    metadata: { summary: string; highlights?: string[]; [key: string]: unknown }
  ): Promise<string> {
    const snapshotDir = join(this.baseDir, delegationId, 'snapshots', snapshotId);
    await mkdir(snapshotDir, { recursive: true });

    const buffer = Buffer.from(snapshotBase64, 'base64');
    const zipPath = join(snapshotDir, 'snapshot.zip');
    await writeFile(zipPath, buffer);

    const metadataPath = join(snapshotDir, 'metadata.json');
    const storedMetadata: StoredSnapshotMetadata = {
      snapshotId,
      delegationId,
      createdAt: new Date().toISOString(),
      ...metadata,
    };
    await writeFile(metadataPath, JSON.stringify(storedMetadata, null, 2));

    return snapshotDir;
  }

  async load(delegationId: string, snapshotId: string): Promise<Buffer> {
    const zipPath = join(this.baseDir, delegationId, 'snapshots', snapshotId, 'snapshot.zip');
    return readFile(zipPath);
  }

  async delete(delegationId: string, snapshotId: string): Promise<void> {
    const snapshotDir = join(this.baseDir, delegationId, 'snapshots', snapshotId);
    await rm(snapshotDir, { recursive: true, force: true });
  }

  async cleanupDelegation(delegationId: string): Promise<void> {
    const snapshotsDir = join(this.baseDir, delegationId, 'snapshots');
    await rm(snapshotsDir, { recursive: true, force: true });
  }
}
