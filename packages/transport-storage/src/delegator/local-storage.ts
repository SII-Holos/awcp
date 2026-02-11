/**
 * Local Filesystem Storage Provider
 *
 * Uses local filesystem for storage, suitable for testing and single-machine setups.
 * Files are served via HTTP URLs that point to the local file server.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StorageProvider, StorageUploadResult } from './storage-provider.js';

export interface LocalStorageConfig {
  baseDir: string;
  baseUrl: string;
}

export class LocalStorageProvider implements StorageProvider {
  private baseDir: string;
  private baseUrl: string;

  constructor(config: LocalStorageConfig) {
    this.baseDir = config.baseDir;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  async upload(key: string, data: Buffer, ttlSeconds: number): Promise<StorageUploadResult> {
    await fs.promises.mkdir(this.baseDir, { recursive: true });
    
    const filePath = path.join(this.baseDir, key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, data);

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const downloadUrl = `${this.baseUrl}/${key}`;
    const uploadUrl = `${this.baseUrl}/${key.replace('.zip', '-result.zip')}`;

    return { downloadUrl, uploadUrl, expiresAt };
  }

  async download(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async generateUrls(key: string, ttlSeconds: number): Promise<StorageUploadResult> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const downloadUrl = `${this.baseUrl}/${key}`;
    const uploadUrl = `${this.baseUrl}/${key.replace('.zip', '-result.zip')}`;
    return { downloadUrl, uploadUrl, expiresAt };
  }

  async release(key: string): Promise<void> {
    const filePath = path.join(this.baseDir, key);
    await fs.promises.unlink(filePath).catch(() => {});
    const resultPath = filePath.replace('.zip', '-result.zip');
    await fs.promises.unlink(resultPath).catch(() => {});
  }
}
