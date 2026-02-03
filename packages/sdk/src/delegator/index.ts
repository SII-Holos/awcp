// High-level API
export { DelegatorService, type DelegatorServiceOptions } from './service.js';
export {
  type DelegatorConfig,
  type EnvironmentConfig,
  type AdmissionConfig,
  type DelegationDefaults,
  type DelegatorHooks,
  type ResolvedDelegatorConfig,
  DEFAULT_DELEGATOR_CONFIG,
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
export { AdmissionController, type AdmissionResult, type WorkspaceStats } from './admission.js';
export { EnvironmentBuilder, type EnvironmentManifest, type EnvironmentBuildResult, type EnvironmentBuilderConfig } from './environment-builder.js';
export { ExecutorClient, type InviteResponse } from './executor-client.js';
export { type ResourceAdapter, ResourceAdapterRegistry, FsResourceAdapter } from './resource-adapters/index.js';
