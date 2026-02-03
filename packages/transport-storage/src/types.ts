export { StorageWorkDirInfo } from '@awcp/core';

export interface StorageProviderConfig {
  type: 's3' | 'local';
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  localDir?: string;
}

export interface StorageDelegatorConfig {
  provider: StorageProviderConfig;
  tempDir?: string;
  urlTtlSeconds?: number;
}

export interface StorageExecutorConfig {
  tempDir?: string;
}

export interface StorageTransportConfig {
  delegator?: StorageDelegatorConfig;
  executor?: StorageExecutorConfig;
}
