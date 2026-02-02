// High-level API
export { ExecutorService, type ExecutorServiceOptions, type ExecutorServiceStatus } from './service.js';
export {
  type ExecutorConfig,
  type PolicyConstraints,
  type ExecutorHooks,
  type TaskStartContext,
  type ResolvedExecutorConfig,
  DEFAULT_EXECUTOR_CONFIG,
  resolveExecutorConfig,
} from './config.js';

// Utilities
export { WorkspaceManager, type WorkspaceValidation } from './workspace-manager.js';
