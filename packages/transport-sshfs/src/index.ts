/**
 * @awcp/transport-sshfs
 * 
 * SSHFS Transport implementation for AWCP data plane
 */

// Delegator-side exports
export {
  CredentialManager,
  type CredentialManagerConfig,
  type GeneratedCredential,
} from './delegator/index.js';

// Executor-side exports
export {
  SshfsMountClient,
  type SshfsMountConfig,
  type MountParams,
} from './executor/index.js';
