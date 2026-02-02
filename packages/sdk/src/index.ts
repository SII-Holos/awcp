/**
 * @awcp/sdk
 *
 * AWCP SDK - Delegator and Executor implementations
 */

// --- Delegator API ---

export {
  DelegatorService,
  type DelegatorServiceOptions,
  type DelegateParams,
  type DelegatorServiceStatus,
  type DelegatorConfig,
  type EnvironmentConfig,
  type DelegationDefaults,
  type DelegatorHooks,
  startDelegatorDaemon,
  DelegatorDaemonClient,
  type DaemonConfig,
  type DaemonInstance,
  type DelegateRequest,
  type DelegateResponse,
  type ListDelegationsResponse,
  AdmissionController,
  type AdmissionConfig,
  type AdmissionResult,
  type WorkspaceStats,
  EnvironmentBuilder,
  type EnvironmentManifest,
  type EnvironmentBuildResult,
  ExecutorClient,
  type ResourceAdapter,
  ResourceAdapterRegistry,
  FsResourceAdapter,
} from './delegator/index.js';

// --- Executor API ---

export {
  ExecutorService,
  type ExecutorServiceOptions,
  type ExecutorServiceStatus,
  type ExecutorConfig,
  type PolicyConstraints,
  type ExecutorHooks,
  type TaskStartContext,
  WorkspaceManager,
  type WorkspaceValidation,
} from './executor/index.js';

// --- Utilities ---

export { resolveWorkDir, type WorkDirContext, cleanupStaleDirectories } from './utils/index.js';
