/**
 * @awcp/transport-storage
 *
 * Storage-based transport for AWCP workspace delegation.
 * Uses pre-signed URLs to transfer workspace archives via external storage.
 */

export { StorageTransport } from './storage-transport.js';

export type { StorageTransportConfig, StorageProviderConfig } from './types.js';
