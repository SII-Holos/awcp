// High-level API
export { ExecutorService, type ExecutorServiceOptions, type ExecutorServiceStatus } from './service.js';
export {
  type ExecutorConfig,
  type MountConfig,
  type PolicyConstraints,
  type ExecutorHooks,
  type ResolvedExecutorConfig,
  DEFAULT_EXECUTOR_CONFIG,
  resolveExecutorConfig,
} from './config.js';

// Utilities (can be used independently)
export { LocalPolicy, type PolicyConfig, type MountPointValidation } from './policy.js';
export { DelegatorClient } from './delegator-client.js';
