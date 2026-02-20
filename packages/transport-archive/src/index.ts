/**
 * @awcp/transport-archive
 *
 * Archive-based transport for AWCP workspace delegation.
 * Uses base64-encoded ZIP archives transmitted inline in protocol messages.
 * Supports chunked transfer for large files.
 */

export { ArchiveDelegatorTransport } from './delegator/transport.js';
export { ArchiveExecutorTransport } from './executor/transport.js';

export type {
  ArchiveTransportConfig,
  ArchiveDelegatorConfig,
  ArchiveExecutorConfig,
  ArchiveWorkDirInfo,
  ChunkedArchiveInfo,
} from './types.js';

export { DEFAULT_DELEGATOR_CONFIG, DEFAULT_EXECUTOR_CONFIG } from './types.js';

export {
  createArchive,
  extractArchive,
  copyDirectory,
  applyResultToResources,
  type CreateArchiveOptions,
} from './utils/index.js';
