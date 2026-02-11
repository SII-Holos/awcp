/**
 * Storage Transport Configuration Types
 */

export interface StorageProviderConfig {
  type: 's3' | 'local';
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  localDir?: string;
}

export interface StorageDelegatorTransportConfig {
  provider: StorageProviderConfig;
  tempDir?: string;
}

export interface StorageExecutorTransportConfig {
  tempDir?: string;
}
