/**
 * Archive Transport Adapter
 *
 * Implements TransportAdapter interface for archive-based file transfer.
 * Uses base64-encoded ZIP archives transmitted inline in protocol messages.
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
  ArchiveWorkDirInfo,
} from '@awcp/core';
import { createArchive, extractArchive, applyResultToResources } from './utils/index.js';
import type { ArchiveTransportConfig } from './types.js';

export class ArchiveTransport implements TransportAdapter {
  readonly type = 'archive' as const;

  private tempDir: string;
  private archives = new Map<string, string>();

  constructor(config: ArchiveTransportConfig = {}) {
    this.tempDir = config.delegator?.tempDir ?? config.executor?.tempDir ?? path.join(os.tmpdir(), 'awcp-archives');
  }

  // ========== Delegator Side ==========

  async prepare(params: TransportPrepareParams): Promise<TransportPrepareResult> {
    const { delegationId, exportPath } = params;

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);

    await createArchive(exportPath, archivePath);

    const buffer = await fs.promises.readFile(archivePath);
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const base64 = buffer.toString('base64');

    this.archives.set(delegationId, archivePath);

    const workDirInfo: ArchiveWorkDirInfo = {
      transport: 'archive',
      workspaceBase64: base64,
      checksum,
    };

    return { workDirInfo };
  }

  async cleanup(delegationId: string): Promise<void> {
    const archivePath = this.archives.get(delegationId);
    if (archivePath) {
      await fs.promises.unlink(archivePath).catch(() => {});
      this.archives.delete(delegationId);
    }
  }

  async applyResult(params: TransportApplyResultParams): Promise<void> {
    const { delegationId, resultData, resources } = params;

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const archivePath = path.join(this.tempDir, `${delegationId}-apply.zip`);
    const extractDir = path.join(this.tempDir, `${delegationId}-apply`);

    const buffer = Buffer.from(resultData, 'base64');
    await fs.promises.writeFile(archivePath, buffer);

    await extractArchive(archivePath, extractDir);
    await fs.promises.unlink(archivePath);

    await applyResultToResources(extractDir, resources);

    await fs.promises.rm(extractDir, { recursive: true, force: true });
  }

  // ========== Executor Side ==========

  async checkDependency(): Promise<DependencyCheckResult> {
    return { available: true };
  }

  async setup(params: TransportSetupParams): Promise<string> {
    const { delegationId, workDirInfo, workDir } = params;

    if (workDirInfo.transport !== 'archive') {
      throw new Error(`ArchiveTransport: unexpected transport type: ${workDirInfo.transport}`);
    }

    const info = workDirInfo as ArchiveWorkDirInfo;

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);

    const buffer = Buffer.from(info.workspaceBase64, 'base64');
    await fs.promises.writeFile(archivePath, buffer);

    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (hash !== info.checksum) {
      await fs.promises.unlink(archivePath);
      throw new Error(`Checksum mismatch: expected ${info.checksum}, got ${hash}`);
    }

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

  // ========== Lifecycle ==========

  async shutdown(): Promise<void> {
    for (const archivePath of this.archives.values()) {
      await fs.promises.unlink(archivePath).catch(() => {});
    }
    this.archives.clear();
  }
}
