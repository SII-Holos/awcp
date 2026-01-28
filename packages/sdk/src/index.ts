/**
 * @awcp/sdk
 * 
 * AWCP SDK - Delegator and Executor Daemon implementations
 */

// ============================================
// High-level API (recommended for most users)
// ============================================

// Delegator-side: Create delegations to Executor agents
export {
  DelegatorService,
  type DelegatorServiceOptions,
  type DelegateParams,
  type DelegatorServiceStatus,
  type DelegatorConfig,
  type SshConfig,
  type DelegationDefaults,
  type DelegatorHooks,
} from './delegator/index.js';

// Executor-side: Enable AWCP support in an A2A agent
export {
  ExecutorService,
  type ExecutorServiceOptions,
  type ExecutorServiceStatus,
  type ExecutorConfig,
  type MountConfig,
  type PolicyConstraints,
  type ExecutorHooks,
} from './executor/index.js';

// ============================================
// Daemon Mode (for running Delegator as independent process)
// ============================================

export {
  startDelegatorDaemon,
  DelegatorDaemonClient,
  type DaemonConfig,
  type DaemonInstance,
  type DelegateRequest,
  type DelegateResponse,
  type ListDelegationsResponse,
} from './delegator/index.js';

// ============================================
// Low-level API (for advanced use)
// ============================================

// Delegator-side low-level exports
export {
  DelegatorDaemon,
  type DelegatorDaemonConfig,
  type DelegatorDaemonEvents,
  AdmissionController,
  type AdmissionConfig,
  type AdmissionResult,
  type WorkspaceStats,
  ExportViewManager,
  ExecutorClient,
} from './delegator/index.js';

// Executor-side low-level exports
export {
  ExecutorDaemon,
  type ExecutorDaemonConfig,
  type ExecutorDaemonEvents,
  LocalPolicy,
  type PolicyConfig,
  type MountPointValidation,
  DelegatorClient,
} from './executor/index.js';

// Re-export core types for convenience
export * from '@awcp/core';
