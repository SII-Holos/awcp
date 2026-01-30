/**
 * AWCP Delegator Configuration
 *
 * Configuration for enabling AWCP Delegator functionality.
 */

import type { Delegation, AccessMode } from '@awcp/core';

/**
 * Export view configuration
 */
export interface ExportConfig {
  /** Base directory for export views, e.g., '/tmp/awcp/exports' */
  baseDir: string;
  /** Strategy for creating export view (default: 'symlink') */
  strategy?: 'symlink' | 'bind' | 'worktree';
}

/**
 * SSH configuration for credential generation
 */
export interface SshConfig {
  /** SSH server host that Executor will connect to */
  host: string;
  /** SSH server port (default: 22) */
  port?: number;
  /** SSH user for Executor connections */
  user: string;
  /** Directory to store temporary keys (default: '/tmp/awcp/keys') */
  keyDir?: string;
  /** Path to CA private key for signing SSH certificates */
  caKeyPath: string;
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
  /** Called when delegation is created and INVITE sent */
  onDelegationCreated?: (delegation: Delegation) => void;
  /** Called when Executor accepts and task starts */
  onDelegationStarted?: (delegation: Delegation) => void;
  /** Called when task completes successfully */
  onDelegationCompleted?: (delegation: Delegation) => void;
  /** Called on error or rejection */
  onError?: (delegationId: string, error: Error) => void;
}

/**
 * AWCP Delegator Configuration
 *
 * @example
 * ```typescript
 * const delegatorConfig: DelegatorConfig = {
 *   export: {
 *     baseDir: '/tmp/awcp/exports',
 *   },
 *   ssh: {
 *     host: 'my-host.example.com',
 *     port: 22,
 *     user: 'awcp',
 *   },
 * };
 * ```
 */
export interface DelegatorConfig {
  /**
   * Export view configuration (required)
   *
   * Specifies how workspaces are exported for Executor access.
   */
  export: ExportConfig;

  /**
   * SSH configuration (required)
   *
   * Specifies SSH server details for SSHFS connections.
   */
  ssh: SshConfig;

  /**
   * Admission control (optional)
   *
   * Limits for workspace size to prevent network issues.
   */
  admission?: AdmissionConfig;

  /**
   * Default values for delegations (optional)
   */
  defaults?: DelegationDefaults;

  /**
   * Lifecycle hooks (optional)
   */
  hooks?: DelegatorHooks;
}

/**
 * Default configuration values
 */
export const DEFAULT_DELEGATOR_CONFIG = {
  ssh: {
    port: 22,
    keyDir: '/tmp/awcp/keys',
  },
  export: {
    strategy: 'symlink' as const,
  },
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
 * Resolved SSH config with all fields
 */
export interface ResolvedSshConfig {
  host: string;
  port: number;
  user: string;
  keyDir: string;
  caKeyPath: string;
}

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
  export: ExportConfig & { strategy: 'symlink' | 'bind' | 'worktree' };
  ssh: ResolvedSshConfig;
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
      baseDir: config.export.baseDir,
      strategy: config.export.strategy ?? DEFAULT_DELEGATOR_CONFIG.export.strategy,
    },
    ssh: {
      host: config.ssh.host,
      port: config.ssh.port ?? DEFAULT_DELEGATOR_CONFIG.ssh.port,
      user: config.ssh.user,
      keyDir: config.ssh.keyDir ?? DEFAULT_DELEGATOR_CONFIG.ssh.keyDir,
      caKeyPath: config.ssh.caKeyPath,
    },
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
