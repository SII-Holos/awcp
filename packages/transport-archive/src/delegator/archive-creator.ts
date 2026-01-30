/**
 * Archive Creator
 *
 * Creates ZIP archives from directories.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import archiver from 'archiver';
import type { ArchiveCreateResult } from '../types.js';

export interface ArchiveCreatorConfig {
  /** Directory to store archive files */
  tempDir?: string;
}

export class ArchiveCreator {
  private tempDir: string;
  private archives = new Map<string, string>();

  constructor(config: ArchiveCreatorConfig = {}) {
    this.tempDir = config.tempDir ?? path.join(os.tmpdir(), 'awcp-archives');
  }

  /**
   * Create a ZIP archive from a directory
   */
  async create(delegationId: string, sourceDir: string): Promise<ArchiveCreateResult> {
    await fs.promises.mkdir(this.tempDir, { recursive: true });

    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);
    const writeStream = fs.createWriteStream(archivePath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    archive.pipe(writeStream);

    // Add directory contents, preserving structure
    archive.directory(sourceDir, false);

    await archive.finalize();

    // Wait for write stream to finish
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // Calculate checksum by reading the file
    const checksum = await this.calculateChecksum(archivePath);
    const stats = await fs.promises.stat(archivePath);

    this.archives.set(delegationId, archivePath);

    return {
      archivePath,
      checksum,
      sizeBytes: stats.size,
    };
  }

  /**
   * Get path to an existing archive
   */
  getArchivePath(delegationId: string): string | undefined {
    return this.archives.get(delegationId);
  }

  /**
   * Clean up archive for a delegation
   */
  async cleanup(delegationId: string): Promise<void> {
    const archivePath = this.archives.get(delegationId);
    if (archivePath) {
      try {
        await fs.promises.unlink(archivePath);
      } catch {
        // Ignore if already deleted
      }
      this.archives.delete(delegationId);
    }
  }

  /**
   * Clean up all archives
   */
  async cleanupAll(): Promise<void> {
    for (const delegationId of this.archives.keys()) {
      await this.cleanup(delegationId);
    }
  }

  private async calculateChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }
}
