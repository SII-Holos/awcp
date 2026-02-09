/**
 * Chunk Receiver - Executor-side chunk receiver
 *
 * Receives, validates, stores chunks, and assembles them into a complete file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { ChunkedArchiveInfo } from '@awcp/core';
import { ChecksumMismatchError } from '@awcp/core';

export interface ChunkReceiverConfig {
  delegationId: string;
  tempDir: string;
  chunkedInfo: ChunkedArchiveInfo;
  timeoutMs: number;
}

export class ChunkReceiver {
  private config: ChunkReceiverConfig;
  private receivedChunks = new Map<number, string>(); // index -> tempFilePath
  private complete = false;
  private assembledPath?: string;
  private timeoutTimer?: ReturnType<typeof setTimeout>;

  constructor(config: ChunkReceiverConfig) {
    this.config = config;
    this.startTimeout();
  }

  /**
   * Receive a single chunk
   */
  async receive(index: number, base64Data: string, checksum: string): Promise<void> {
    if (this.complete) {
      throw new Error('Chunk receiver already complete');
    }

    const { chunkCount, chunkChecksums } = this.config.chunkedInfo;

    if (index < 0 || index >= chunkCount) {
      throw new Error(`Invalid chunk index: ${index}, expected 0-${chunkCount - 1}`);
    }

    if (this.receivedChunks.has(index)) {
      // Idempotent: skip if already received
      return;
    }

    const buffer = Buffer.from(base64Data, 'base64');
    const actualChecksum = crypto.createHash('sha256').update(buffer).digest('hex');

    if (actualChecksum !== checksum) {
      throw new ChecksumMismatchError(checksum, actualChecksum);
    }

    if (actualChecksum !== chunkChecksums[index]) {
      throw new ChecksumMismatchError(chunkChecksums[index]!, actualChecksum);
    }

    await fs.promises.mkdir(this.config.tempDir, { recursive: true });
    const chunkPath = path.join(
      this.config.tempDir,
      `${this.config.delegationId}-chunk-${index}`
    );
    await fs.promises.writeFile(chunkPath, buffer);
    this.receivedChunks.set(index, chunkPath);
    this.resetTimeout();
  }

  /**
   * Assemble all chunks into a complete file
   */
  async assemble(totalChecksum: string): Promise<string> {
    const { chunkCount, totalChecksum: expectedChecksum } = this.config.chunkedInfo;

    if (this.receivedChunks.size !== chunkCount) {
      const missing = this.getMissingIndices();
      throw new Error(`Missing chunks: ${missing.join(', ')}`);
    }

    if (totalChecksum !== expectedChecksum) {
      throw new ChecksumMismatchError(expectedChecksum, totalChecksum);
    }

    this.clearTimeout();

    const archivePath = path.join(this.config.tempDir, `${this.config.delegationId}.zip`);
    const writeStream = fs.createWriteStream(archivePath);

    for (let i = 0; i < chunkCount; i++) {
      const chunkPath = this.receivedChunks.get(i)!;
      const chunkData = await fs.promises.readFile(chunkPath);
      writeStream.write(chunkData);
      await fs.promises.unlink(chunkPath).catch(() => {});
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.end((err: Error | null) => (err ? reject(err) : resolve()));
    });

    const buffer = await fs.promises.readFile(archivePath);
    const actualChecksum = crypto.createHash('sha256').update(buffer).digest('hex');

    if (actualChecksum !== expectedChecksum) {
      await fs.promises.unlink(archivePath).catch(() => {});
      throw new ChecksumMismatchError(expectedChecksum, actualChecksum);
    }

    this.complete = true;
    this.assembledPath = archivePath;
    this.receivedChunks.clear();

    return archivePath;
  }

  /**
   * Get current status
   */
  getStatus(): { received: number[]; missing: number[]; complete: boolean } {
    return {
      received: Array.from(this.receivedChunks.keys()).sort((a, b) => a - b),
      missing: this.getMissingIndices(),
      complete: this.complete,
    };
  }

  /**
   * Check if assembly is complete
   */
  isComplete(): boolean {
    return this.complete;
  }

  /**
   * Get the assembled archive path
   */
  getAssembledPath(): string {
    if (!this.assembledPath) {
      throw new Error('Archive not assembled yet');
    }
    return this.assembledPath;
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    this.clearTimeout();

    for (const chunkPath of this.receivedChunks.values()) {
      await fs.promises.unlink(chunkPath).catch(() => {});
    }
    this.receivedChunks.clear();

    if (this.assembledPath) {
      await fs.promises.unlink(this.assembledPath).catch(() => {});
      this.assembledPath = undefined;
    }
  }

  private getMissingIndices(): number[] {
    const missing: number[] = [];
    for (let i = 0; i < this.config.chunkedInfo.chunkCount; i++) {
      if (!this.receivedChunks.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  private startTimeout(): void {
    this.timeoutTimer = setTimeout(() => this.onTimeout(), this.config.timeoutMs);
  }

  private resetTimeout(): void {
    this.clearTimeout();
    this.startTimeout();
  }

  private clearTimeout(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
  }

  private async onTimeout(): Promise<void> {
    console.warn(`[AWCP:ChunkReceiver] Timeout for ${this.config.delegationId}`);
    await this.cleanup();
  }
}
