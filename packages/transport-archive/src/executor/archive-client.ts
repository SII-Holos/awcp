/**
 * Archive Client
 *
 * HTTP client for downloading and uploading archives.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { ArchiveExecutorConfig } from '../types.js';

const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export class ArchiveClient {
  private tempDir: string;
  private downloadTimeout: number;
  private uploadTimeout: number;

  constructor(config: ArchiveExecutorConfig = {}) {
    this.tempDir = config.tempDir ?? path.join(os.tmpdir(), 'awcp-archives');
    this.downloadTimeout = config.downloadTimeout ?? DEFAULT_TIMEOUT;
    this.uploadTimeout = config.uploadTimeout ?? DEFAULT_TIMEOUT;
  }

  /**
   * Download an archive from a URL
   */
  async download(
    url: string,
    delegationId: string,
    expectedChecksum?: string,
  ): Promise<string> {
    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.downloadTimeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('Download failed: no response body');
      }

      // Write to file and calculate checksum simultaneously
      const hash = crypto.createHash('sha256');
      const writeStream = fs.createWriteStream(archivePath);

      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          writeStream.write(value);
        }
      } finally {
        reader.releaseLock();
      }

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        writeStream.end();
      });

      // Verify checksum if provided
      if (expectedChecksum) {
        const actualChecksum = hash.digest('hex');
        if (actualChecksum !== expectedChecksum) {
          await fs.promises.unlink(archivePath);
          throw new Error(
            `Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`,
          );
        }
      }

      return archivePath;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Upload an archive to a URL
   */
  async upload(archivePath: string, url: string): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.uploadTimeout);

    try {
      const stats = await fs.promises.stat(archivePath);
      const fileStream = fs.createReadStream(archivePath);

      // Convert Node.js stream to web stream for fetch
      const webStream = new ReadableStream({
        start(controller) {
          fileStream.on('data', (chunk) => controller.enqueue(chunk));
          fileStream.on('end', () => controller.close());
          fileStream.on('error', (err) => controller.error(err));
        },
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/zip',
          'Content-Length': stats.size.toString(),
        },
        body: webStream,
        signal: controller.signal,
        duplex: 'half',
      } as RequestInit);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Upload failed: ${response.status} ${response.statusText} - ${text}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Clean up downloaded archive
   */
  async cleanup(delegationId: string): Promise<void> {
    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);
    try {
      await fs.promises.unlink(archivePath);
    } catch {
      // Ignore if already deleted
    }
  }
}
