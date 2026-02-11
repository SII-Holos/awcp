// High-level API
export { DelegatorService, type DelegatorServiceOptions, type DelegatorRequestHandler, type DelegatorServiceStatus, type DelegatorDelegationInfo } from './service.js';
export {
  type DelegatorConfig,
  type DelegatorAdmissionConfig,
  type DelegationConfig,
  type DelegateParams,
  type DelegatorHooks,
  type ResolvedDelegatorConfig,
  DEFAULT_ADMISSION,
  DEFAULT_DELEGATION,
  resolveDelegatorConfig,
} from './config.js';

// Daemon mode
export {
  startDelegatorDaemon,
  type DaemonConfig,
  type DaemonInstance,
} from './bin/daemon.js';
export {
  DelegatorDaemonClient,
  type DelegateRequest,
  type DelegateResponse,
  type ListDelegationsResponse,
} from './bin/client.js';

// Utilities
export { AdmissionController, type WorkspaceStats } from './admission.js';
export { DelegationManager, type DelegationManagerConfig } from './delegation-manager.js';
export { EnvironmentManager, type EnvironmentManifest, type EnvironmentBuildResult, type EnvironmentManagerConfig } from './environment-manager.js';
export { ExecutorClient, type InviteResponse } from './executor-client.js';
export { type ResourceAdapter, ResourceAdapterRegistry, FsResourceAdapter } from './resource-adapters/index.js';
