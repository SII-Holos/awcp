/**
 * @awcp/transport-archive
 *
 * Archive-based transport for AWCP workspace delegation.
 * Uses base64-encoded ZIP archives transmitted inline in protocol messages.
 */

export { ArchiveTransport } from './archive-transport.js';

export type { ArchiveTransportConfig } from './types.js';

// Shared utilities for ZIP-based transports
export {
  createArchive,
  extractArchive,
  copyDirectory,
  applyResultToResources,
  type CreateArchiveOptions,
} from './utils/index.js';
