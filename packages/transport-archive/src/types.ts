/**
 * Archive Transport Configuration Types
 */

export { ArchiveWorkDirInfo, ChunkedArchiveInfo } from '@awcp/core';

export interface ArchiveDelegatorConfig {
  /** Temp directory for archives */
  tempDir?: string;
  /** Chunk threshold (bytes), enables chunked transfer above this size, default 10MB */
  chunkThreshold?: number;
  /** Chunk size (bytes), default 2MB */
  chunkSize?: number;
  /** Concurrent upload count, 0 means serial, default 3 */
  uploadConcurrency?: number;
  /** Per-chunk upload retry count, default 3 */
  chunkRetries?: number;
  /** Per-chunk upload timeout (ms), default 30000 */
  chunkTimeout?: number;
}

export interface ArchiveExecutorConfig {
  /** Temp directory for archives */
  tempDir?: string;
  /** Chunk receive timeout (ms), default 5 minutes */
  chunkReceiveTimeout?: number;
}

export interface ArchiveTransportConfig {
  delegator?: ArchiveDelegatorConfig;
  executor?: ArchiveExecutorConfig;
}

/**
 * Default configuration values
 */
export const DEFAULT_DELEGATOR_CONFIG = {
  chunkThreshold: 2 * 1024 * 1024,   // 2MB (lowered to facilitate testing chunked transfer)
  chunkSize: 512 * 1024,             // 512KB (smaller chunks for easier observation)
  uploadConcurrency: 3,
  chunkRetries: 3,
  chunkTimeout: 30000,
} as const;

export const DEFAULT_EXECUTOR_CONFIG = {
  chunkReceiveTimeout: 5 * 60 * 1000, // 5 minutes
} as const;
