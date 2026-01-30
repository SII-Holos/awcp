/**
 * @awcp/transport-archive
 *
 * Archive-based transport for AWCP workspace delegation.
 * Uses HTTP file transfer instead of SSHFS mount.
 */

export { ArchiveTransport } from './archive-transport.js';

export type {
  ArchiveTransportConfig,
  ArchiveDelegatorConfig,
  ArchiveExecutorConfig,
  ArchiveCreateResult,
  ArchiveMountInfo,
} from './types.js';

export { ArchiveCreator, ArchiveServer } from './delegator/index.js';
export { ArchiveClient, ArchiveExtractor } from './executor/index.js';
