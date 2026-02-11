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
  type DelegatorAdmissionConfig,
  type DelegationConfig,
  type DelegateParams,
  type DelegatorRequestHandler,
  type DelegatorServiceStatus,
  type DelegatorDelegationInfo,
  type DelegatorHooks,
  startDelegatorDaemon,
  DelegatorDaemonClient,
  type DaemonConfig,
  type DaemonInstance,
  type DelegateRequest,
  type DelegateResponse,
  type ListDelegationsResponse,
  AdmissionController,
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
  type ExecutorAdmissionConfig,
  type AssignmentConfig,
  type TaskExecutor,
  type TaskExecutionContext,
  type TaskExecutionResult,
  type ExecutorHooks,
  type TaskStartContext,
  WorkspaceManager,
  A2ATaskExecutor,
} from './executor/index.js';

// --- Listener API ---

export {
  type ExecutorRequestHandler,
  type ExecutorServiceStatus,
  type DelegationStatusInfo,
  type TaskResultResponse,
  type TaskResultStatus,
  type ListenerAdapter,
  type ListenerCallbacks,
  type ListenerInfo,
  HttpListener,
  type HttpListenerConfig,
  WebSocketTunnelListener,
  type WebSocketTunnelConfig,
} from './listener/index.js';

// --- Utilities ---

export { resolveWorkDir, type WorkDirContext, cleanupStaleDirectories } from './utils/index.js';
