/**
 * @awcp/transport-storage
 *
 * Storage-based transport for AWCP workspace delegation.
 * Uses pre-signed URLs to transfer workspace archives via external storage.
 */

export { StorageDelegatorTransport } from './delegator/transport.js';
export { StorageExecutorTransport } from './executor/transport.js';

export type { StorageDelegatorTransportConfig, StorageExecutorTransportConfig, StorageProviderConfig } from './types.js';

export type { StorageProvider, StorageUploadResult } from './delegator/storage-provider.js';
export { LocalStorageProvider, type LocalStorageConfig } from './delegator/local-storage.js';
