/**
 * Archive Transport Adapter
 *
 * Implements TransportAdapter interface for archive-based file transfer.
 * Downloads workspace as ZIP, works locally, uploads changes back.
 */

import type {
  TransportAdapter,
  TransportPrepareParams,
  TransportPrepareResult,
  TransportSetupParams,
  TransportTeardownParams,
  DependencyCheckResult,
  ArchiveMountInfo,
} from '@awcp/core';
import { ArchiveCreator } from './delegator/archive-creator.js';
import { ArchiveServer } from './delegator/archive-server.js';
import { ArchiveClient } from './executor/archive-client.js';
import { ArchiveExtractor } from './executor/archive-extractor.js';
import type { ArchiveTransportConfig } from './types.js';

interface DelegationContext {
  exportDir: string;
  uploadUrl: string;
}

export class ArchiveTransport implements TransportAdapter {
  readonly type = 'archive' as const;

  private creator?: ArchiveCreator;
  private server?: ArchiveServer;
  private client?: ArchiveClient;
  private extractor?: ArchiveExtractor;

  // Track delegation context for teardown
  private delegationContexts = new Map<string, DelegationContext>();

  constructor(private config: ArchiveTransportConfig = {}) {}

  // ========== Delegator Side ==========

  async prepare(params: TransportPrepareParams): Promise<TransportPrepareResult> {
    const { delegationId, exportPath } = params;

    // Lazy init delegator components
    if (!this.creator) {
      this.creator = new ArchiveCreator(this.config.delegator);
    }
    if (!this.server) {
      this.server = new ArchiveServer(this.config.delegator);
      await this.server.start();
    }

    // Create archive from export directory
    const result = await this.creator.create(delegationId, exportPath);

    // Register with HTTP server
    this.server.register(delegationId, result.archivePath, exportPath);

    const mountInfo: ArchiveMountInfo = {
      transport: 'archive',
      downloadUrl: this.server.downloadUrl(delegationId),
      uploadUrl: this.server.uploadUrl(delegationId),
      checksum: result.checksum,
    };

    return { mountInfo };
  }

  async cleanup(delegationId: string): Promise<void> {
    // Apply uploaded changes to export directory
    if (this.server) {
      const uploadedArchive = this.server.getUploadedArchive(delegationId);
      const exportDir = this.server.getExportDir(delegationId);

      if (uploadedArchive && exportDir) {
        if (!this.extractor) {
          this.extractor = new ArchiveExtractor();
        }
        await this.extractor.applyChanges(uploadedArchive, exportDir);
      }

      this.server.unregister(delegationId);
    }

    // Clean up archive file
    await this.creator?.cleanup(delegationId);
  }

  // ========== Executor Side ==========

  async checkDependency(): Promise<DependencyCheckResult> {
    // Archive transport only needs Node.js built-ins + npm packages
    // which are bundled, so always available
    return { available: true };
  }

  async setup(params: TransportSetupParams): Promise<string> {
    const { delegationId, mountInfo, workDir } = params;

    if (mountInfo.transport !== 'archive') {
      throw new Error(`ArchiveTransport: unexpected transport type: ${mountInfo.transport}`);
    }

    const info = mountInfo as ArchiveMountInfo;

    // Lazy init executor components
    if (!this.client) {
      this.client = new ArchiveClient(this.config.executor);
    }
    if (!this.extractor) {
      this.extractor = new ArchiveExtractor();
    }

    // Download archive
    const archivePath = await this.client.download(
      info.downloadUrl,
      delegationId,
      info.checksum,
    );

    // Extract to work directory
    await this.extractor.extract(archivePath, workDir);

    // Store context for teardown
    this.delegationContexts.set(delegationId, {
      exportDir: workDir,
      uploadUrl: info.uploadUrl,
    });

    // Clean up downloaded archive (we have extracted it)
    await this.client.cleanup(delegationId);

    return workDir;
  }

  async teardown(params: TransportTeardownParams): Promise<void> {
    const { delegationId, workDir } = params;

    const context = this.delegationContexts.get(delegationId);
    if (!context) {
      return;
    }

    if (!this.extractor) {
      this.extractor = new ArchiveExtractor();
    }
    if (!this.client) {
      this.client = new ArchiveClient(this.config.executor);
    }

    // Create archive from work directory
    const archivePath = `${workDir}.zip`;
    await this.extractor.createArchive(workDir, archivePath);

    // Upload to delegator
    await this.client.upload(archivePath, context.uploadUrl);

    // Clean up
    this.delegationContexts.delete(delegationId);

    // Remove the temporary archive
    const fs = await import('node:fs');
    try {
      await fs.promises.unlink(archivePath);
    } catch {
      // Ignore
    }
  }

  // ========== Lifecycle ==========

  /**
   * Stop the archive server (call when shutting down)
   */
  async shutdown(): Promise<void> {
    await this.server?.stop();
    await this.creator?.cleanupAll();
  }
}
