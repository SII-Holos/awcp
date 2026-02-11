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
  ArchiveTransportHandle,
} from '@awcp/core';
import { ChecksumMismatchError } from '@awcp/core';
import { createArchive, extractArchive } from '../utils/index.js';
import type { ArchiveExecutorTransportConfig } from '../types.js';

export class ArchiveExecutorTransport implements ExecutorTransportAdapter {
  readonly type = 'archive' as const;
  readonly capabilities: TransportCapabilities = {
    supportsSnapshots: true,
    liveSync: false,
  };

  private tempDir: string;

  constructor(config: ArchiveExecutorTransportConfig = {}) {
    this.tempDir = config.tempDir ?? path.join(os.tmpdir(), 'awcp-archives');
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.tempDir, { recursive: true });
    await this.cleanOrphanedFiles();
  }

  async shutdown(): Promise<void> {
    await this.cleanOrphanedFiles();
  }

  async checkDependency(): Promise<DependencyCheckResult> {
    return { available: true };
  }

  async setup(params: TransportSetupParams): Promise<string> {
    const { delegationId, handle, localPath } = params;

    if (handle.transport !== 'archive') {
      throw new Error(`ArchiveExecutorTransport: unexpected transport type: ${handle.transport}`);
    }

    const info = handle as ArchiveTransportHandle;
    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);

    try {
      const buffer = Buffer.from(info.workspaceBase64, 'base64');

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
    const archivePath = path.join(this.tempDir, `${delegationId}-result.zip`);

    try {
      await createArchive(localPath, archivePath, { exclude: [] });
      const buffer = await fs.promises.readFile(archivePath);
      return { snapshotBase64: buffer.toString('base64') };
    } finally {
      await fs.promises.unlink(archivePath).catch(() => {});
    }
  }

  async detach(_params: TransportReleaseParams): Promise<void> {}

  async release(_params: TransportReleaseParams): Promise<void> {}

  private async cleanOrphanedFiles(): Promise<void> {
    const entries = await fs.promises.readdir(this.tempDir).catch(() => []);
    for (const entry of entries) {
      if (entry.endsWith('.zip')) {
        await fs.promises.unlink(path.join(this.tempDir, entry)).catch(() => {});
      }
    }
  }
}
