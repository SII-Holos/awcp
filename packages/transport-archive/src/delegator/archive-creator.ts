/**
 * Creates ZIP archives from directories for archive-based transport.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import archiver from 'archiver';
import type { ArchiveCreateResult } from '../types.js';

export interface ArchiveCreatorConfig {
  tempDir?: string;
}

export class ArchiveCreator {
  private tempDir: string;
  private archives = new Map<string, string>();

  constructor(config: ArchiveCreatorConfig = {}) {
    this.tempDir = config.tempDir ?? path.join(os.tmpdir(), 'awcp-archives');
  }

  async create(delegationId: string, sourceDir: string): Promise<ArchiveCreateResult> {
    await fs.promises.mkdir(this.tempDir, { recursive: true });

    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);
    const writeStream = fs.createWriteStream(archivePath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    archive.pipe(writeStream);
    archive.glob('**/*', {
      cwd: sourceDir,
      ignore: ['.awcp/**'],
      dot: true,
      follow: true,
    });
    await archive.finalize();

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    const checksum = await this.calculateChecksum(archivePath);
    const stats = await fs.promises.stat(archivePath);
    const base64 = await this.readAsBase64(archivePath);

    this.archives.set(delegationId, archivePath);

    return {
      archivePath,
      checksum,
      sizeBytes: stats.size,
      base64,
    };
  }

  async cleanup(delegationId: string): Promise<void> {
    const archivePath = this.archives.get(delegationId);
    if (archivePath) {
      try {
        await fs.promises.unlink(archivePath);
      } catch {
        // File may already be removed
      }
      this.archives.delete(delegationId);
    }
  }

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

  private async readAsBase64(filePath: string): Promise<string> {
    const buffer = await fs.promises.readFile(filePath);
    return buffer.toString('base64');
  }
}
