/**
 * @awcp/sdk
 * 
 * AWCP SDK - Delegator and Executor implementations
 */

// ============================================
// Delegator API (for creating delegations)
// ============================================

export {
  // Service
  DelegatorService,
  type DelegatorServiceOptions,
  type DelegateParams,
  type DelegatorServiceStatus,
  // Config
  type DelegatorConfig,
  type SshConfig,
  type DelegationDefaults,
  type DelegatorHooks,
  // Daemon mode
  startDelegatorDaemon,
  DelegatorDaemonClient,
  type DaemonConfig,
  type DaemonInstance,
  type DelegateRequest,
  type DelegateResponse,
  type ListDelegationsResponse,
  // Utilities
  AdmissionController,
  type AdmissionConfig,
  type AdmissionResult,
  type WorkspaceStats,
  ExportViewManager,
  ExecutorClient,
} from './delegator/index.js';

// ============================================
// Executor API (for executing delegations)
// ============================================

export {
  // Service
  ExecutorService,
  type ExecutorServiceOptions,
  type ExecutorServiceStatus,
  // Config
  type ExecutorConfig,
  type MountConfig,
  type PolicyConstraints,
  type ExecutorHooks,
  // Utilities
  LocalPolicy,
  type PolicyConfig,
  type MountPointValidation,
  DelegatorClient,
} from './executor/index.js';

// ============================================
// Re-export core types for convenience
// ============================================

export * from '@awcp/core';
