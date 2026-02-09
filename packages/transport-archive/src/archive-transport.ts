/**
 * Archive Transport Adapter
 *
 * Implements TransportAdapter interface for archive-based file transfer.
 * Supports both inline base64 (small files) and chunked transfer (large files).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type {
  TransportAdapter,
  TransportCapabilities,
  TransportPrepareParams,
  TransportPrepareResult,
  TransportSetupParams,
  TransportTeardownParams,
  TransportTeardownResult,
  TransportApplySnapshotParams,
  DependencyCheckResult,
  ArchiveWorkDirInfo,
  ChunkedArchiveInfo,
} from '@awcp/core';
import { TransportError, ChecksumMismatchError } from '@awcp/core';
import { createArchive, extractArchive, applyResultToResources } from './utils/index.js';
import {
  type ArchiveTransportConfig,
  type ArchiveDelegatorConfig,
  type ArchiveExecutorConfig,
  DEFAULT_DELEGATOR_CONFIG,
  DEFAULT_EXECUTOR_CONFIG,
} from './types.js';
import { ChunkReceiver } from './chunk-receiver.js';
import { ChunkUploader } from './chunk-uploader.js';

interface ChunkedArchiveData {
  archivePath: string;
  chunkedInfo: ChunkedArchiveInfo;
}

export class ArchiveTransport implements TransportAdapter {
  readonly type = 'archive' as const;
  readonly capabilities: TransportCapabilities = {
    supportsSnapshots: true,
    liveSync: false,
  };

  private tempDir: string;
  private delegatorConfig: Required<Omit<ArchiveDelegatorConfig, 'tempDir'>>;
  private executorConfig: Required<Omit<ArchiveExecutorConfig, 'tempDir'>>;

  // Delegator side: small file archive paths
  private archives = new Map<string, string>();
  // Delegator side: large file chunked data
  private chunkedArchives = new Map<string, ChunkedArchiveData>();

  // Executor side: chunk receivers
  private chunkReceivers = new Map<string, ChunkReceiver>();

  constructor(config: ArchiveTransportConfig = {}) {
    this.tempDir =
      config.delegator?.tempDir ?? config.executor?.tempDir ?? path.join(os.tmpdir(), 'awcp-archives');

    this.delegatorConfig = {
      chunkThreshold: config.delegator?.chunkThreshold ?? DEFAULT_DELEGATOR_CONFIG.chunkThreshold,
      chunkSize: config.delegator?.chunkSize ?? DEFAULT_DELEGATOR_CONFIG.chunkSize,
      uploadConcurrency: config.delegator?.uploadConcurrency ?? DEFAULT_DELEGATOR_CONFIG.uploadConcurrency,
      chunkRetries: config.delegator?.chunkRetries ?? DEFAULT_DELEGATOR_CONFIG.chunkRetries,
      chunkTimeout: config.delegator?.chunkTimeout ?? DEFAULT_DELEGATOR_CONFIG.chunkTimeout,
    };

    this.executorConfig = {
      chunkReceiveTimeout:
        config.executor?.chunkReceiveTimeout ?? DEFAULT_EXECUTOR_CONFIG.chunkReceiveTimeout,
    };
  }

  // ========== Delegator Side ==========

  async prepare(params: TransportPrepareParams): Promise<TransportPrepareResult> {
    const { delegationId, exportPath } = params;

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    // Use -delegator suffix to avoid conflict with Executor's ChunkReceiver
    const archivePath = path.join(this.tempDir, `${delegationId}-delegator.zip`);

    await createArchive(exportPath, archivePath);

    const stats = await fs.promises.stat(archivePath);
    const totalSize = stats.size;

    const totalChecksum = await this.computeFileChecksum(archivePath);

    // Decide whether to use chunked transfer
    if (totalSize < this.delegatorConfig.chunkThreshold) {
      // Small file: inline base64
      const buffer = await fs.promises.readFile(archivePath);
      const base64 = buffer.toString('base64');

      this.archives.set(delegationId, archivePath);

      const workDirInfo: ArchiveWorkDirInfo = {
        transport: 'archive',
        workspaceBase64: base64,
        checksum: totalChecksum,
      };

      return { workDirInfo };
    }

    // Large file: chunked mode
    const { chunkSize } = this.delegatorConfig;
    const chunkCount = Math.ceil(totalSize / chunkSize);

    const chunkChecksums = await this.computeChunkChecksums(archivePath, chunkSize, chunkCount);

    const chunkedInfo: ChunkedArchiveInfo = {
      totalSize,
      chunkSize,
      chunkCount,
      totalChecksum,
      chunkChecksums,
    };

    this.chunkedArchives.set(delegationId, { archivePath, chunkedInfo });

    const workDirInfo: ArchiveWorkDirInfo = {
      transport: 'archive',
      chunked: chunkedInfo,
      checksum: totalChecksum,
    };

    return { workDirInfo };
  }

  /**
   * Upload all chunks to Executor
   * Called by DelegatorService after sendStart
   */
  async uploadChunks(delegationId: string, executorUrl: string): Promise<void> {
    const data = this.chunkedArchives.get(delegationId);
    if (!data) {
      return; // Not chunked mode, nothing to upload
    }

    const uploader = new ChunkUploader({
      concurrency: this.delegatorConfig.uploadConcurrency,
      retries: this.delegatorConfig.chunkRetries,
      timeout: this.delegatorConfig.chunkTimeout,
    });

    const target = { executorUrl, delegationId };

    // Query already-received chunks (for resume)
    let skipIndices: number[] = [];
    try {
      const status = await uploader.getStatus(target);
      skipIndices = status.received;
      if (skipIndices.length > 0) {
        console.log(`[AWCP:ArchiveTransport] Resuming upload, skipping chunks: ${skipIndices.join(', ')}`);
      }
    } catch {
      // Ignore status query failures
    }

    await uploader.upload(data.archivePath, data.chunkedInfo, target, skipIndices);
    await uploader.complete(target, data.chunkedInfo.totalChecksum);

    this.chunkedArchives.delete(delegationId);
    await fs.promises.unlink(data.archivePath).catch(() => {});
  }

  /**
   * Check if delegation is in chunked mode
   */
  isChunkedMode(delegationId: string): boolean {
    return this.chunkedArchives.has(delegationId);
  }

  async cleanup(delegationId: string): Promise<void> {
    const archivePath = this.archives.get(delegationId);
    if (archivePath) {
      await fs.promises.unlink(archivePath).catch(() => {});
      this.archives.delete(delegationId);
    }

    const chunkedData = this.chunkedArchives.get(delegationId);
    if (chunkedData) {
      await fs.promises.unlink(chunkedData.archivePath).catch(() => {});
      this.chunkedArchives.delete(delegationId);
    }
  }

  async applySnapshot(params: TransportApplySnapshotParams): Promise<void> {
    const { delegationId, snapshotData, resources } = params;

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const archivePath = path.join(this.tempDir, `${delegationId}-apply.zip`);
    const extractDir = path.join(this.tempDir, `${delegationId}-apply`);

    const buffer = Buffer.from(snapshotData, 'base64');
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

  /**
   * Initialize chunk receiver
   * Called by ExecutorService after receiving chunked START
   */
  initChunkReceiver(delegationId: string, chunkedInfo: ChunkedArchiveInfo): void {
    const receiver = new ChunkReceiver({
      delegationId,
      tempDir: this.tempDir,
      chunkedInfo,
      timeoutMs: this.executorConfig.chunkReceiveTimeout,
    });
    this.chunkReceivers.set(delegationId, receiver);
  }

  /**
   * Receive a single chunk
   */
  async receiveChunk(delegationId: string, index: number, data: string, checksum: string): Promise<void> {
    const receiver = this.chunkReceivers.get(delegationId);
    if (!receiver) {
      throw new TransportError(`No chunk receiver for delegation: ${delegationId}`);
    }
    await receiver.receive(index, data, checksum);
  }

  /**
   * Complete chunk reception, assemble file
   */
  async completeChunks(delegationId: string, totalChecksum: string): Promise<void> {
    const receiver = this.chunkReceivers.get(delegationId);
    if (!receiver) {
      throw new TransportError(`No chunk receiver for delegation: ${delegationId}`);
    }
    await receiver.assemble(totalChecksum);
    // Note: don't delete receiver yet, setup() needs it to get the path
  }

  /**
   * Get chunk reception status
   */
  getChunkStatus(delegationId: string): { exists: boolean; received: number[]; missing: number[]; complete: boolean } {
    const receiver = this.chunkReceivers.get(delegationId);
    if (!receiver) {
      return { exists: false, received: [], missing: [], complete: false };
    }
    const status = receiver.getStatus();
    return { exists: true, ...status };
  }

  async setup(params: TransportSetupParams): Promise<string> {
    const { delegationId, workDirInfo, workDir } = params;

    if (workDirInfo.transport !== 'archive') {
      throw new TransportError(`Unexpected transport type: ${workDirInfo.transport}`);
    }

    const info = workDirInfo as ArchiveWorkDirInfo;

    // Chunked mode
    if (info.chunked) {
      const receiver = this.chunkReceivers.get(delegationId);
      if (!receiver || !receiver.isComplete()) {
        throw new TransportError('Chunked transfer not complete');
      }

      const archivePath = receiver.getAssembledPath();
      await extractArchive(archivePath, workDir);
      await fs.promises.unlink(archivePath).catch(() => {});
      this.chunkReceivers.delete(delegationId);

      return workDir;
    }

    // Inline mode
    if (!info.workspaceBase64) {
      throw new TransportError('Missing workspaceBase64 in non-chunked mode');
    }

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);

    const buffer = Buffer.from(info.workspaceBase64, 'base64');
    await fs.promises.writeFile(archivePath, buffer);

    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (hash !== info.checksum) {
      await fs.promises.unlink(archivePath);
      throw new ChecksumMismatchError(info.checksum, hash);
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
    const snapshotBase64 = buffer.toString('base64');

    await fs.promises.unlink(archivePath);

    return { snapshotBase64 };
  }

  // ========== Lifecycle ==========

  async shutdown(): Promise<void> {
    for (const archivePath of this.archives.values()) {
      await fs.promises.unlink(archivePath).catch(() => {});
    }
    this.archives.clear();

    for (const data of this.chunkedArchives.values()) {
      await fs.promises.unlink(data.archivePath).catch(() => {});
    }
    this.chunkedArchives.clear();

    for (const receiver of this.chunkReceivers.values()) {
      await receiver.cleanup();
    }
    this.chunkReceivers.clear();
  }

  // ========== Private Helpers ==========

  private async computeFileChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private async computeChunkChecksums(
    filePath: string,
    chunkSize: number,
    chunkCount: number
  ): Promise<string[]> {
    const checksums: string[] = [];
    const fileHandle = await fs.promises.open(filePath, 'r');

    try {
      for (let i = 0; i < chunkCount; i++) {
        const buffer = Buffer.alloc(chunkSize);
        const { bytesRead } = await fileHandle.read(buffer, 0, chunkSize, i * chunkSize);
        const chunk = buffer.subarray(0, bytesRead);
        const checksum = crypto.createHash('sha256').update(chunk).digest('hex');
        checksums.push(checksum);
      }
    } finally {
      await fileHandle.close();
    }

    return checksums;
  }
}
