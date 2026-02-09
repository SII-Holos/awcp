/**
 * @awcp/transport-archive
 *
 * Archive-based transport for AWCP workspace delegation.
 * Uses base64-encoded ZIP archives transmitted inline in protocol messages.
 * Supports chunked transfer for large files.
 */

export { ArchiveTransport } from './archive-transport.js';

export type {
  ArchiveTransportConfig,
  ArchiveDelegatorConfig,
  ArchiveExecutorConfig,
  ArchiveWorkDirInfo,
  ChunkedArchiveInfo,
} from './types.js';

export { DEFAULT_DELEGATOR_CONFIG, DEFAULT_EXECUTOR_CONFIG } from './types.js';

// Shared utilities for ZIP-based transports
export {
  createArchive,
  extractArchive,
  copyDirectory,
  applyResultToResources,
  type CreateArchiveOptions,
} from './utils/index.js';
