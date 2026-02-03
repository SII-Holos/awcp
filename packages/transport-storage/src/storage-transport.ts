/**
 * Storage Transport Adapter
 *
 * Implements TransportAdapter interface for URL-based storage transfer.
 * Uses pre-signed URLs to upload/download workspace archives.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type {
  TransportAdapter,
  TransportPrepareParams,
  TransportPrepareResult,
  TransportSetupParams,
  TransportTeardownParams,
  TransportTeardownResult,
  TransportApplyResultParams,
  DependencyCheckResult,
  StorageWorkDirInfo,
} from '@awcp/core';
import { createArchive, extractArchive, applyResultToResources } from '@awcp/transport-archive';
import type { StorageTransportConfig } from './types.js';
import type { StorageProvider } from './delegator/storage-provider.js';
import { LocalStorageProvider } from './delegator/local-storage.js';

export class StorageTransport implements TransportAdapter {
  readonly type = 'storage' as const;

  private provider?: StorageProvider;
  private tempDir: string;
  private config: StorageTransportConfig;

  constructor(config: StorageTransportConfig = {}) {
    this.config = config;
    this.tempDir = config.delegator?.tempDir ?? config.executor?.tempDir ?? path.join(os.tmpdir(), 'awcp-storage');
  }

  private getProvider(): StorageProvider {
    if (!this.provider) {
      const delegatorConfig = this.config.delegator;
      if (!delegatorConfig?.provider) {
        throw new Error('Storage provider not configured');
      }
      
      if (delegatorConfig.provider.type === 'local') {
        this.provider = new LocalStorageProvider({
          baseDir: delegatorConfig.provider.localDir!,
          baseUrl: delegatorConfig.provider.endpoint!,
        });
      } else {
        throw new Error(`Storage provider type '${delegatorConfig.provider.type}' not implemented`);
      }
    }
    return this.provider;
  }

  // ========== Delegator Side ==========

  async prepare(params: TransportPrepareParams): Promise<TransportPrepareResult> {
    const { delegationId, exportPath, ttlSeconds } = params;

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);

    await createArchive(exportPath, archivePath);

    const buffer = await fs.promises.readFile(archivePath);
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

    const provider = this.getProvider();
    const key = `workspaces/${delegationId}.zip`;
    const { downloadUrl, uploadUrl, expiresAt } = await provider.upload(key, buffer, ttlSeconds);

    await fs.promises.unlink(archivePath);

    const workDirInfo: StorageWorkDirInfo = {
      transport: 'storage',
      downloadUrl,
      uploadUrl,
      checksum,
      expiresAt,
    };

    return { workDirInfo };
  }

  async applyResult(params: TransportApplyResultParams): Promise<void> {
    const { delegationId, resultData, resources } = params;

    const resultInfo = JSON.parse(resultData) as { resultUrl: string };

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const archivePath = path.join(this.tempDir, `${delegationId}-apply.zip`);
    const extractDir = path.join(this.tempDir, `${delegationId}-apply`);

    const response = await fetch(resultInfo.resultUrl);
    if (!response.ok) {
      throw new Error(`Failed to download result: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(archivePath, buffer);

    await extractArchive(archivePath, extractDir);
    await fs.promises.unlink(archivePath);

    await applyResultToResources(extractDir, resources);

    await fs.promises.rm(extractDir, { recursive: true, force: true });
  }

  async cleanup(delegationId: string): Promise<void> {
    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);
    await fs.promises.unlink(archivePath).catch(() => {});
  }

  // ========== Executor Side ==========

  async checkDependency(): Promise<DependencyCheckResult> {
    return { available: true };
  }

  async setup(params: TransportSetupParams): Promise<string> {
    const { delegationId, workDirInfo, workDir } = params;

    if (workDirInfo.transport !== 'storage') {
      throw new Error(`StorageTransport: unexpected transport type: ${workDirInfo.transport}`);
    }

    const info = workDirInfo as StorageWorkDirInfo;

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);

    const response = await fetch(info.downloadUrl, {
      headers: info.headers,
    });
    if (!response.ok) {
      throw new Error(`Failed to download workspace: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (hash !== info.checksum) {
      throw new Error(`Checksum mismatch: expected ${info.checksum}, got ${hash}`);
    }

    await fs.promises.writeFile(archivePath, buffer);
    await extractArchive(archivePath, workDir);
    await fs.promises.unlink(archivePath);

    return workDir;
  }

  async teardown(params: TransportTeardownParams): Promise<TransportTeardownResult> {
    const { delegationId, workDir } = params;

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const archivePath = path.join(this.tempDir, `${delegationId}-result.zip`);

    await createArchive(workDir, archivePath, { exclude: [] });

    const buffer = await fs.promises.readFile(archivePath);
    const resultBase64 = buffer.toString('base64');

    await fs.promises.unlink(archivePath);

    return { resultBase64 };
  }
}
