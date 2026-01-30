/**
 * Archive Transport Configuration Types
 */

export { ArchiveMountInfo } from '@awcp/core';

/**
 * Delegator-side configuration for archive transport
 */
export interface ArchiveDelegatorConfig {
  /** Directory for storing temporary archive files (default: os.tmpdir()/awcp-archives) */
  tempDir?: string;

  /** Port for built-in HTTP server. 0 = random port (default: 0) */
  serverPort?: number;

  /**
   * External base URL for download/upload endpoints.
   * If not set, uses the built-in server's URL (http://127.0.0.1:<port>).
   * Set this when running behind a proxy or in cloud environments.
   */
  publicBaseUrl?: string;
}

/**
 * Executor-side configuration for archive transport
 */
export interface ArchiveExecutorConfig {
  /** Directory for storing downloaded archives (default: os.tmpdir()/awcp-archives) */
  tempDir?: string;

  /** Download timeout in milliseconds (default: 5 minutes) */
  downloadTimeout?: number;

  /** Upload timeout in milliseconds (default: 5 minutes) */
  uploadTimeout?: number;
}

/**
 * Combined configuration for ArchiveTransport
 */
export interface ArchiveTransportConfig {
  /** Delegator-side configuration */
  delegator?: ArchiveDelegatorConfig;

  /** Executor-side configuration */
  executor?: ArchiveExecutorConfig;
}

/**
 * Result from creating an archive
 */
export interface ArchiveCreateResult {
  /** Path to the created archive file */
  archivePath: string;

  /** SHA256 checksum of the archive */
  checksum: string;

  /** Size in bytes */
  sizeBytes: number;
}
