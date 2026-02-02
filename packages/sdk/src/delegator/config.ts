/**
 * AWCP Delegator Configuration
 */

import type { Delegation, AccessMode, DelegatorTransportAdapter } from '@awcp/core';

/**
 * Environment builder configuration
 */
export interface EnvironmentConfig {
  /** Base directory for environment directories */
  baseDir: string;
}

/**
 * Admission control configuration
 */
export interface AdmissionConfig {
  /** Maximum total bytes allowed (default: 100MB) */
  maxTotalBytes?: number;
  /** Maximum file count allowed (default: 10000) */
  maxFileCount?: number;
  /** Maximum single file size (default: 50MB) */
  maxSingleFileBytes?: number;
}

/**
 * Default values for delegations
 */
export interface DelegationDefaults {
  /** Default TTL in seconds (default: 3600) */
  ttlSeconds?: number;
  /** Default access mode (default: 'rw') */
  accessMode?: AccessMode;
}

/**
 * Lifecycle hooks for Delegator events
 */
export interface DelegatorHooks {
  onDelegationCreated?: (delegation: Delegation) => void;
  onDelegationStarted?: (delegation: Delegation) => void;
  onDelegationCompleted?: (delegation: Delegation) => void;
  onError?: (delegationId: string, error: Error) => void;
}

/**
 * AWCP Delegator Configuration
 */
export interface DelegatorConfig {
  /** Environment builder configuration */
  environment: EnvironmentConfig;
  /** Transport adapter for data plane */
  transport: DelegatorTransportAdapter;
  /** Admission control */
  admission?: AdmissionConfig;
  /** Default values for delegations */
  defaults?: DelegationDefaults;
  /** Lifecycle hooks */
  hooks?: DelegatorHooks;
}

/**
 * Default configuration values
 */
export const DEFAULT_DELEGATOR_CONFIG = {
  admission: {
    maxTotalBytes: 100 * 1024 * 1024, // 100MB
    maxFileCount: 10000,
    maxSingleFileBytes: 50 * 1024 * 1024, // 50MB
  },
  defaults: {
    ttlSeconds: 3600,
    accessMode: 'rw' as AccessMode,
  },
} as const;

/**
 * Resolved admission config with all fields
 */
export interface ResolvedAdmissionConfig {
  maxTotalBytes: number;
  maxFileCount: number;
  maxSingleFileBytes: number;
}

/**
 * Resolved defaults with all fields
 */
export interface ResolvedDelegationDefaults {
  ttlSeconds: number;
  accessMode: AccessMode;
}

/**
 * Resolved configuration with all defaults applied
 */
export interface ResolvedDelegatorConfig {
  export: EnvironmentConfig;
  transport: DelegatorTransportAdapter;
  admission: ResolvedAdmissionConfig;
  defaults: ResolvedDelegationDefaults;
  hooks: DelegatorHooks;
}

/**
 * Merge user config with defaults
 */
export function resolveDelegatorConfig(config: DelegatorConfig): ResolvedDelegatorConfig {
  return {
    export: {
      baseDir: config.environment.baseDir,
    },
    transport: config.transport,
    admission: {
      maxTotalBytes: config.admission?.maxTotalBytes ?? DEFAULT_DELEGATOR_CONFIG.admission.maxTotalBytes,
      maxFileCount: config.admission?.maxFileCount ?? DEFAULT_DELEGATOR_CONFIG.admission.maxFileCount,
      maxSingleFileBytes: config.admission?.maxSingleFileBytes ?? DEFAULT_DELEGATOR_CONFIG.admission.maxSingleFileBytes,
    },
    defaults: {
      ttlSeconds: config.defaults?.ttlSeconds ?? DEFAULT_DELEGATOR_CONFIG.defaults.ttlSeconds,
      accessMode: config.defaults?.accessMode ?? DEFAULT_DELEGATOR_CONFIG.defaults.accessMode,
    },
    hooks: config.hooks ?? {},
  };
}
