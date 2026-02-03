/**
 * Archive Transport Configuration Types
 */

export { ArchiveWorkDirInfo } from '@awcp/core';

export interface ArchiveDelegatorConfig {
  tempDir?: string;
}

export interface ArchiveExecutorConfig {
  tempDir?: string;
}

export interface ArchiveTransportConfig {
  delegator?: ArchiveDelegatorConfig;
  executor?: ArchiveExecutorConfig;
}
