/**
 * AWCP Delegator Configuration
 */

import type { Delegation, AccessMode, DelegatorTransportAdapter, SnapshotPolicy, EnvironmentSnapshot } from '@awcp/core';
import type { AdmissionConfig } from './admission.js';

// Re-export for convenience
export type { AdmissionConfig } from './admission.js';

/**
 * Snapshot policy configuration
 */
export interface SnapshotConfig {
  /** Snapshot mode: auto=immediate apply, staged=store for selection, discard=no storage */
  mode?: SnapshotPolicy;
  /** Retention time in ms for staged snapshots (default: 30 minutes) */
  retentionMs?: number;
  /** Maximum snapshots per delegation (default: 10) */
  maxSnapshots?: number;
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
  onSnapshotReceived?: (delegation: Delegation, snapshot: EnvironmentSnapshot) => void;
  onSnapshotApplied?: (delegation: Delegation, snapshot: EnvironmentSnapshot) => void;
  onError?: (delegationId: string, error: Error) => void;
}

/**
 * AWCP Delegator Configuration
 */
export interface DelegatorConfig {
  /** Base directory for all delegation data (environments, snapshots) */
  baseDir: string;
  /** Transport adapter for data plane */
  transport: DelegatorTransportAdapter;
  /** Admission control */
  admission?: AdmissionConfig;
  /** Snapshot policy */
  snapshot?: SnapshotConfig;
  /** Default values for delegations */
  defaults?: DelegationDefaults;
  /** Lifecycle hooks */
  hooks?: DelegatorHooks;
}

/**
 * Default admission thresholds
 */
export const DEFAULT_ADMISSION = {
  maxTotalBytes: 100 * 1024 * 1024,      // 100MB
  maxFileCount: 10000,
  maxSingleFileBytes: 50 * 1024 * 1024,  // 50MB
} as const;

/**
 * Default snapshot settings
 */
export const DEFAULT_SNAPSHOT = {
  mode: 'auto' as SnapshotPolicy,
  retentionMs: 30 * 60 * 1000,           // 30 minutes
  maxSnapshots: 10,
} as const;

/**
 * Default delegation settings
 */
export const DEFAULT_DELEGATION = {
  ttlSeconds: 3600,
  accessMode: 'rw' as AccessMode,
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
 * Resolved snapshot config with all fields
 */
export interface ResolvedSnapshotConfig {
  mode: SnapshotPolicy;
  retentionMs: number;
  maxSnapshots: number;
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
  baseDir: string;
  transport: DelegatorTransportAdapter;
  admission: ResolvedAdmissionConfig;
  snapshot: ResolvedSnapshotConfig;
  defaults: ResolvedDelegationDefaults;
  hooks: DelegatorHooks;
}

export function resolveDelegatorConfig(config: DelegatorConfig): ResolvedDelegatorConfig {
  return {
    baseDir: config.baseDir,
    transport: config.transport,
    admission: {
      maxTotalBytes: config.admission?.maxTotalBytes ?? DEFAULT_ADMISSION.maxTotalBytes,
      maxFileCount: config.admission?.maxFileCount ?? DEFAULT_ADMISSION.maxFileCount,
      maxSingleFileBytes: config.admission?.maxSingleFileBytes ?? DEFAULT_ADMISSION.maxSingleFileBytes,
    },
    snapshot: {
      mode: config.snapshot?.mode ?? DEFAULT_SNAPSHOT.mode,
      retentionMs: config.snapshot?.retentionMs ?? DEFAULT_SNAPSHOT.retentionMs,
      maxSnapshots: config.snapshot?.maxSnapshots ?? DEFAULT_SNAPSHOT.maxSnapshots,
    },
    defaults: {
      ttlSeconds: config.defaults?.ttlSeconds ?? DEFAULT_DELEGATION.ttlSeconds,
      accessMode: config.defaults?.accessMode ?? DEFAULT_DELEGATION.accessMode,
    },
    hooks: config.hooks ?? {},
  };
}
