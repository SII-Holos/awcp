/**
 * @awcp/transport-archive
 *
 * Archive-based transport for AWCP workspace delegation.
 * Uses base64-encoded ZIP archives transmitted inline in protocol messages.
 */

export { ArchiveDelegatorTransport } from './delegator/transport.js';
export { ArchiveExecutorTransport } from './executor/transport.js';

export type { ArchiveDelegatorTransportConfig, ArchiveExecutorTransportConfig } from './types.js';

export {
  createArchive,
  extractArchive,
  copyDirectory,
  applyResultToResources,
  type CreateArchiveOptions,
} from './utils/index.js';
