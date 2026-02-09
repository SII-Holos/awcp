/**
 * Chunk Uploader - Delegator-side chunk uploader
 *
 * Supports streaming reads, concurrent/serial upload, per-chunk retry, and resume.
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type { ChunkedArchiveInfo } from '@awcp/core';

export interface ChunkUploaderConfig {
  /** Concurrent upload count, 0 means serial */
  concurrency: number;
  /** Per-chunk retry count */
  retries: number;
  /** Per-chunk upload timeout (ms) */
  timeout: number;
}

export interface UploadTarget {
  /** Executor URL */
  executorUrl: string;
  /** Delegation ID */
  delegationId: string;
}

interface ChunkMeta {
  index: number;
  offset: number;
  size: number;
  checksum: string;
}

export class ChunkUploader {
  private config: ChunkUploaderConfig;

  constructor(config: ChunkUploaderConfig) {
    this.config = config;
  }

  /**
   * Upload all chunks
   *
   * @param archivePath ZIP file path
   * @param chunkedInfo Chunk metadata
   * @param target Upload target
   * @param skipIndices Chunk indices to skip (for resume)
   */
  async upload(
    archivePath: string,
    chunkedInfo: ChunkedArchiveInfo,
    target: UploadTarget,
    skipIndices: number[] = []
  ): Promise<void> {
    const skipSet = new Set(skipIndices);

    const chunksToUpload: ChunkMeta[] = [];
    for (let i = 0; i < chunkedInfo.chunkCount; i++) {
      if (skipSet.has(i)) continue;

      chunksToUpload.push({
        index: i,
        offset: i * chunkedInfo.chunkSize,
        size:
          i === chunkedInfo.chunkCount - 1
            ? chunkedInfo.totalSize - i * chunkedInfo.chunkSize
            : chunkedInfo.chunkSize,
        checksum: chunkedInfo.chunkChecksums[i]!,
      });
    }

    if (chunksToUpload.length === 0) {
      return;
    }

    const { concurrency } = this.config;

    if (concurrency === 0 || concurrency === 1) {
      for (const chunk of chunksToUpload) {
        await this.uploadChunk(archivePath, chunk, target);
      }
    } else {
      const queue = [...chunksToUpload];
      const workers: Promise<void>[] = [];

      for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
        workers.push(this.worker(archivePath, queue, target));
      }

      await Promise.all(workers);
    }
  }

  /**
   * Complete upload, notify Executor to assemble
   */
  async complete(target: UploadTarget, totalChecksum: string): Promise<void> {
    const url = `${target.executorUrl.replace(/\/$/, '')}/chunks/${target.delegationId}/complete`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalChecksum }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Chunk complete failed: ${response.status} ${text}`);
    }
  }

  /**
   * Query chunk status (for resume)
   */
  async getStatus(target: UploadTarget): Promise<{ received: number[]; missing: number[] }> {
    const url = `${target.executorUrl.replace(/\/$/, '')}/chunks/${target.delegationId}/status`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return { received: [], missing: [] };
      }
      throw new Error(`Get chunk status failed: ${response.status}`);
    }

    return (await response.json()) as { received: number[]; missing: number[] };
  }

  private async worker(
    archivePath: string,
    queue: ChunkMeta[],
    target: UploadTarget
  ): Promise<void> {
    while (queue.length > 0) {
      const chunk = queue.shift();
      if (!chunk) break;
      await this.uploadChunk(archivePath, chunk, target);
    }
  }

  private async uploadChunk(
    archivePath: string,
    chunk: ChunkMeta,
    target: UploadTarget
  ): Promise<void> {
    const { retries, timeout } = this.config;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const buffer = await this.readChunk(archivePath, chunk.offset, chunk.size);

        const actualChecksum = crypto.createHash('sha256').update(buffer).digest('hex');
        if (actualChecksum !== chunk.checksum) {
          throw new Error(`Local chunk checksum mismatch at index ${chunk.index}`);
        }

        const url = `${target.executorUrl.replace(/\/$/, '')}/chunks/${target.delegationId}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              index: chunk.index,
              data: buffer.toString('base64'),
              checksum: chunk.checksum,
            }),
            signal: controller.signal,
          });

          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Chunk upload failed: ${response.status} ${text}`);
          }

          return;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        console.warn(
          `[AWCP:ChunkUploader] Chunk ${chunk.index} attempt ${attempt}/${retries} failed:`,
          error instanceof Error ? error.message : error
        );

        if (attempt === retries) {
          throw error;
        }

        // Exponential backoff
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  /**
   * Read a range of bytes from file
   */
  private async readChunk(filePath: string, offset: number, size: number): Promise<Buffer> {
    const buffer = Buffer.alloc(size);
    const fileHandle = await fs.promises.open(filePath, 'r');

    try {
      await fileHandle.read(buffer, 0, size, offset);
      return buffer;
    } finally {
      await fileHandle.close();
    }
  }
}
