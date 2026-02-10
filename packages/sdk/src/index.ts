/**
 * @awcp/sdk
 *
 * AWCP SDK - Delegator and Executor implementations
 */

// --- Delegator API ---

export {
  DelegatorService,
  type DelegatorServiceOptions,
  type DelegatorConfig,
  type DelegationConfig,
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
  type WorkspaceStats,
  EnvironmentManager,
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
  type ExecutorConfig,
  type AssignmentConfig,
  type ExecutorHooks,
  type TaskStartContext,
  WorkspaceManager,
  type WorkspaceValidation,
  A2ATaskExecutor,
} from './executor/index.js';

// --- Listener API ---

export {
  HttpListener,
  type HttpListenerConfig,
  WebSocketTunnelListener,
  type WebSocketTunnelConfig,
} from './listener/index.js';

// --- Utilities ---

export { resolveWorkDir, type WorkDirContext, cleanupStaleDirectories } from './utils/index.js';
