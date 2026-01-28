// High-level API (recommended)
export {
  DelegatorService,
  type DelegatorServiceOptions,
  type DelegateParams,
  type DelegatorServiceStatus,
} from './service.js';
export {
  type DelegatorConfig,
  type ExportConfig,
  type SshConfig,
  type AdmissionConfig as DelegatorAdmissionConfig,
  type DelegationDefaults,
  type DelegatorHooks,
  type ResolvedDelegatorConfig,
  DEFAULT_DELEGATOR_CONFIG,
  resolveDelegatorConfig,
} from './config.js';

// Daemon mode (for running as independent process)
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

// Low-level API (for advanced use)
export { DelegatorDaemon, type DelegatorDaemonConfig, type DelegatorDaemonEvents } from './daemon.js';
export { AdmissionController, type AdmissionConfig, type AdmissionResult, type WorkspaceStats } from './admission.js';
export { ExportViewManager } from './export-view.js';
export { ExecutorClient, type InviteResponse } from './executor-client.js';
