/**
 * AWCP Executor Configuration
 *
 * Configuration for enabling AWCP support in an A2A agent.
 */

import type { InviteMessage, SandboxProfile, AccessMode } from '@awcp/core';

/**
 * Mount configuration
 */
export interface MountConfig {
  /** Root directory for mount points, e.g., '/tmp/awcp/mounts' */
  root: string;
}

/**
 * Policy constraints for accepting delegations
 */
export interface PolicyConstraints {
  /** Max concurrent delegations (default: 5) */
  maxConcurrentDelegations?: number;
  /** Max TTL in seconds to accept (default: 3600) */
  maxTtlSeconds?: number;
  /** Allowed access modes (default: ['ro', 'rw']) */
  allowedAccessModes?: AccessMode[];
  /** Auto-accept INVITEs without confirmation (default: true) */
  autoAccept?: boolean;
}

/**
 * Lifecycle hooks for AWCP events
 */
export interface ExecutorHooks {
  /** Called when INVITE received. Return false to decline. */
  onInvite?: (invite: InviteMessage) => Promise<boolean>;
  /** Called when task execution starts */
  onTaskStart?: (delegationId: string, mountPoint: string) => void;
  /** Called when task completes successfully */
  onTaskComplete?: (delegationId: string, summary: string) => void;
  /** Called on error */
  onError?: (delegationId: string, error: Error) => void;
}

/**
 * AWCP Executor Configuration
 *
 * @example
 * ```typescript
 * const awcpConfig: ExecutorConfig = {
 *   mount: {
 *     root: '/tmp/awcp/mounts',
 *   },
 *   sandbox: {
 *     cwdOnly: true,
 *     allowNetwork: true,
 *     allowExec: true,
 *   },
 *   policy: {
 *     maxConcurrentDelegations: 3,
 *     autoAccept: true,
 *   },
 * };
 * ```
 */
export interface ExecutorConfig {
  /**
   * Mount configuration (required)
   *
   * Specifies where delegator workspaces will be mounted.
   */
  mount: MountConfig;

  /**
   * Sandbox profile (optional)
   *
   * Capability declaration sent in ACCEPT message to inform Delegator
   * about this agent's execution constraints.
   */
  sandbox?: SandboxProfile;

  /**
   * Policy constraints (optional)
   *
   * Rules for accepting or rejecting delegation requests.
   */
  policy?: PolicyConstraints;

  /**
   * Lifecycle hooks (optional)
   *
   * Callbacks for various AWCP lifecycle events.
   */
  hooks?: ExecutorHooks;
}

/**
 * Default configuration values
 */
export const DEFAULT_EXECUTOR_CONFIG = {
  policy: {
    maxConcurrentDelegations: 5,
    maxTtlSeconds: 3600,
    allowedAccessModes: ['ro', 'rw'] as AccessMode[],
    autoAccept: true,
  },
  sandbox: {
    cwdOnly: true,
    allowNetwork: true,
    allowExec: true,
  },
} as const;

/**
 * Resolved policy with all fields required
 */
export interface ResolvedPolicyConstraints {
  maxConcurrentDelegations: number;
  maxTtlSeconds: number;
  allowedAccessModes: AccessMode[];
  autoAccept: boolean;
}

/**
 * Resolved configuration with all defaults applied
 */
export interface ResolvedExecutorConfig {
  mount: MountConfig;
  sandbox: SandboxProfile;
  policy: ResolvedPolicyConstraints;
  hooks: ExecutorHooks;
}

/**
 * Merge user config with defaults
 */
export function resolveExecutorConfig(config: ExecutorConfig): ResolvedExecutorConfig {
  return {
    mount: config.mount,
    sandbox: config.sandbox ?? { ...DEFAULT_EXECUTOR_CONFIG.sandbox },
    policy: {
      maxConcurrentDelegations: config.policy?.maxConcurrentDelegations ?? DEFAULT_EXECUTOR_CONFIG.policy.maxConcurrentDelegations,
      maxTtlSeconds: config.policy?.maxTtlSeconds ?? DEFAULT_EXECUTOR_CONFIG.policy.maxTtlSeconds,
      allowedAccessModes: config.policy?.allowedAccessModes ?? [...DEFAULT_EXECUTOR_CONFIG.policy.allowedAccessModes],
      autoAccept: config.policy?.autoAccept ?? DEFAULT_EXECUTOR_CONFIG.policy.autoAccept,
    },
    hooks: config.hooks ?? {},
  };
}
