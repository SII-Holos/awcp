import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type {
  ExecutorTransportAdapter,
  TransportCapabilities,
  TransportSetupParams,
  TransportReleaseParams,
  TransportCaptureSnapshotParams,
  TransportCaptureSnapshotResult,
  DependencyCheckResult,
  StorageTransportHandle,
} from '@awcp/core';
import { TransportError, ChecksumMismatchError } from '@awcp/core';
import { createArchive, extractArchive } from '@awcp/transport-archive';
import type { StorageExecutorTransportConfig } from '../types.js';

export class StorageExecutorTransport implements ExecutorTransportAdapter {
  readonly type = 'storage' as const;
  readonly capabilities: TransportCapabilities = {
    supportsSnapshots: true,
    liveSync: false,
  };

  private tempDir: string;
  private activeHandles = new Map<string, StorageTransportHandle>();

  constructor(config: StorageExecutorTransportConfig = {}) {
    this.tempDir = config.tempDir ?? path.join(os.tmpdir(), 'awcp-storage');
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.tempDir, { recursive: true });
    await this.cleanOrphanedFiles();
  }

  async shutdown(): Promise<void> {
    this.activeHandles.clear();
    await this.cleanOrphanedFiles();
  }

  async checkDependency(): Promise<DependencyCheckResult> {
    return { available: true };
  }

  async setup(params: TransportSetupParams): Promise<string> {
    const { delegationId, handle, localPath } = params;

    if (handle.transport !== 'storage') {
      throw new TransportError(`StorageExecutorTransport: unexpected transport type: ${handle.transport}`);
    }

    const info = handle as StorageTransportHandle;
    this.activeHandles.set(delegationId, info);

    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);

    try {
      const response = await fetch(info.downloadUrl, {
        headers: info.headers,
      });
      if (!response.ok) {
        throw new TransportError(`Failed to download workspace: ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      if (hash !== info.checksum) {
        throw new ChecksumMismatchError(info.checksum, hash);
      }

      await fs.promises.writeFile(archivePath, buffer);
      await extractArchive(archivePath, localPath);
    } finally {
      await fs.promises.unlink(archivePath).catch(() => {});
    }

    return localPath;
  }

  async captureSnapshot(params: TransportCaptureSnapshotParams): Promise<TransportCaptureSnapshotResult> {
    const { delegationId, localPath } = params;
    const info = this.activeHandles.get(delegationId);
    const archivePath = path.join(this.tempDir, `${delegationId}-result.zip`);

    try {
      await createArchive(localPath, archivePath, { exclude: [] });
      const buffer = await fs.promises.readFile(archivePath);

      if (info?.uploadUrl) {
        const response = await fetch(info.uploadUrl, {
          method: 'PUT',
          body: buffer,
          headers: { 'Content-Type': 'application/zip' },
        });
        if (!response.ok) {
          throw new TransportError(`Failed to upload snapshot: ${response.status}`);
        }
        return { snapshotBase64: JSON.stringify({ resultUrl: info.uploadUrl }) };
      }

      return { snapshotBase64: buffer.toString('base64') };
    } finally {
      await fs.promises.unlink(archivePath).catch(() => {});
    }
  }

  async detach(params: TransportReleaseParams): Promise<void> {
    this.activeHandles.delete(params.delegationId);
  }

  async release(params: TransportReleaseParams): Promise<void> {
    this.activeHandles.delete(params.delegationId);
  }

  private async cleanOrphanedFiles(): Promise<void> {
    const entries = await fs.promises.readdir(this.tempDir).catch(() => []);
    for (const entry of entries) {
      if (entry.endsWith('.zip')) {
        await fs.promises.unlink(path.join(this.tempDir, entry)).catch(() => {});
      }
    }
  }
}
