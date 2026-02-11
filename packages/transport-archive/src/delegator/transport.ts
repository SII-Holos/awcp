import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type {
  DelegatorTransportAdapter,
  TransportCapabilities,
  TransportPrepareParams,
  TransportHandle,
  ArchiveTransportHandle,
  TransportApplySnapshotParams,
} from '@awcp/core';
import { createArchive, extractArchive, applyResultToResources } from '../utils/index.js';
import type { ArchiveDelegatorTransportConfig } from '../types.js';

export class ArchiveDelegatorTransport implements DelegatorTransportAdapter {
  readonly type = 'archive' as const;
  readonly capabilities: TransportCapabilities = {
    supportsSnapshots: true,
    liveSync: false,
  };

  private tempDir: string;

  constructor(config: ArchiveDelegatorTransportConfig = {}) {
    this.tempDir = config.tempDir ?? path.join(os.tmpdir(), 'awcp-archives');
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.tempDir, { recursive: true });
    await this.cleanOrphanedFiles();
  }

  async shutdown(): Promise<void> {
    await this.cleanOrphanedFiles();
  }

  async prepare(params: TransportPrepareParams): Promise<TransportHandle> {
    const { delegationId, exportPath } = params;
    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);

    try {
      await createArchive(exportPath, archivePath);
      const buffer = await fs.promises.readFile(archivePath);
      const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

      const handle: ArchiveTransportHandle = {
        transport: 'archive',
        workspaceBase64: buffer.toString('base64'),
        checksum,
      };
      return handle;
    } finally {
      await fs.promises.unlink(archivePath).catch(() => {});
    }
  }

  async applySnapshot(params: TransportApplySnapshotParams): Promise<void> {
    const { delegationId, snapshotData, resources } = params;
    const archivePath = path.join(this.tempDir, `${delegationId}-snapshot.zip`);
    const extractDir = path.join(this.tempDir, `${delegationId}-snapshot`);

    try {
      const buffer = Buffer.from(snapshotData, 'base64');
      await fs.promises.writeFile(archivePath, buffer);
      await extractArchive(archivePath, extractDir);
      await applyResultToResources(extractDir, resources);
    } finally {
      await fs.promises.unlink(archivePath).catch(() => {});
      await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async detach(_delegationId: string): Promise<void> {}

  async release(_delegationId: string): Promise<void> {}

  private async cleanOrphanedFiles(): Promise<void> {
    const entries = await fs.promises.readdir(this.tempDir).catch(() => []);
    for (const entry of entries) {
      if (entry.endsWith('.zip')) {
        await fs.promises.unlink(path.join(this.tempDir, entry)).catch(() => {});
      }
    }
    // Clean orphaned snapshot extract directories
    for (const entry of entries) {
      if (entry.endsWith('-snapshot')) {
        await fs.promises.rm(path.join(this.tempDir, entry), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
