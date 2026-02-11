import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type {
  DelegatorTransportAdapter,
  TransportCapabilities,
  TransportPrepareParams,
  TransportHandle,
  StorageTransportHandle,
  TransportApplySnapshotParams,
} from '@awcp/core';
import { TransportError } from '@awcp/core';
import { createArchive, extractArchive, applyResultToResources } from '@awcp/transport-archive';
import type { StorageDelegatorTransportConfig } from '../types.js';
import type { StorageProvider } from './storage-provider.js';
import { LocalStorageProvider } from './local-storage.js';

export class StorageDelegatorTransport implements DelegatorTransportAdapter {
  readonly type = 'storage' as const;
  readonly capabilities: TransportCapabilities = {
    supportsSnapshots: true,
    liveSync: false,
  };

  private provider: StorageProvider;
  private tempDir: string;

  constructor(config: StorageDelegatorTransportConfig) {
    this.tempDir = config.tempDir ?? path.join(os.tmpdir(), 'awcp-storage');

    if (config.provider.type === 'local') {
      this.provider = new LocalStorageProvider({
        baseDir: config.provider.localDir!,
        baseUrl: config.provider.endpoint!,
      });
    } else {
      throw new TransportError(`Storage provider type '${config.provider.type}' not implemented`);
    }
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.tempDir, { recursive: true });
    await this.cleanOrphanedFiles();
  }

  async shutdown(): Promise<void> {
    await this.cleanOrphanedFiles();
  }

  async prepare(params: TransportPrepareParams): Promise<TransportHandle> {
    const { delegationId, exportPath, ttlSeconds } = params;
    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);

    try {
      await createArchive(exportPath, archivePath);
      const buffer = await fs.promises.readFile(archivePath);
      const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

      const key = this.storageKey(delegationId);
      const { downloadUrl, uploadUrl, expiresAt } = await this.provider.upload(key, buffer, ttlSeconds);

      const handle: StorageTransportHandle = {
        transport: 'storage',
        downloadUrl,
        uploadUrl,
        checksum,
        expiresAt,
      };
      return handle;
    } finally {
      await fs.promises.unlink(archivePath).catch(() => {});
    }
  }

  async applySnapshot(params: TransportApplySnapshotParams): Promise<void> {
    const { delegationId, snapshotData, resources } = params;
    const snapshotInfo = JSON.parse(snapshotData) as { resultUrl: string };
    const archivePath = path.join(this.tempDir, `${delegationId}-snapshot.zip`);
    const extractDir = path.join(this.tempDir, `${delegationId}-snapshot`);

    try {
      const response = await fetch(snapshotInfo.resultUrl);
      if (!response.ok) {
        throw new TransportError(`Failed to download snapshot: ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.promises.writeFile(archivePath, buffer);
      await extractArchive(archivePath, extractDir);
      await applyResultToResources(extractDir, resources);
    } finally {
      await fs.promises.unlink(archivePath).catch(() => {});
      await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async detach(_delegationId: string): Promise<void> {}

  async release(delegationId: string): Promise<void> {
    const key = this.storageKey(delegationId);
    await this.provider.release(key).catch(() => {});
  }

  private storageKey(delegationId: string): string {
    return `workspaces/${delegationId}.zip`;
  }

  private async cleanOrphanedFiles(): Promise<void> {
    const entries = await fs.promises.readdir(this.tempDir).catch(() => []);
    for (const entry of entries) {
      if (entry.endsWith('.zip')) {
        await fs.promises.unlink(path.join(this.tempDir, entry)).catch(() => {});
      }
      if (entry.endsWith('-snapshot')) {
        await fs.promises.rm(path.join(this.tempDir, entry), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
