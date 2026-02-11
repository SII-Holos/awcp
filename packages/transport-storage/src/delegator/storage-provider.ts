/**
 * Storage Provider Interface
 *
 * Abstract interface for different storage backends (S3, local filesystem, etc.)
 *
 * TODO: Implement S3StorageProvider for production cloud deployments
 */

export interface StorageUploadResult {
  downloadUrl: string;
  uploadUrl: string;
  expiresAt: string;
}

export interface StorageProvider {
  upload(key: string, data: Buffer, ttlSeconds: number): Promise<StorageUploadResult>;
  download(url: string, headers?: Record<string, string>): Promise<Buffer>;
  generateUrls(key: string, ttlSeconds: number): Promise<StorageUploadResult>;
  release(key: string): Promise<void>;
}
