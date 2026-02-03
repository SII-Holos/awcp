/**
 * AWCP Executor Configuration
 */

import type {
  InviteMessage,
  SandboxProfile,
  AccessMode,
  ExecutorTransportAdapter,
  ActiveLease,
  TaskSpec,
  EnvironmentDeclaration,
  ListenerAdapter,
  ListenerInfo,
} from '@awcp/core';

export interface PolicyConstraints {
  maxConcurrentDelegations?: number;
  maxTtlSeconds?: number;
  allowedAccessModes?: AccessMode[];
  autoAccept?: boolean;
  resultRetentionMs?: number;
}

export interface TaskStartContext {
  delegationId: string;
  workPath: string;
  task: TaskSpec;
  lease: ActiveLease;
  environment: EnvironmentDeclaration;
}

export interface ExecutorHooks {
  onInvite?: (invite: InviteMessage) => Promise<boolean>;
  onTaskStart?: (context: TaskStartContext) => void;
  onTaskComplete?: (delegationId: string, summary: string) => void;
  onError?: (delegationId: string, error: Error) => void;
  onListenerConnected?: (info: ListenerInfo) => void;
  onListenerDisconnected?: (type: string, error?: Error) => void;
}

export interface ExecutorConfig {
  workDir: string;
  transport: ExecutorTransportAdapter;
  sandbox?: SandboxProfile;
  policy?: PolicyConstraints;
  hooks?: ExecutorHooks;
  listeners?: ListenerAdapter[];
}

export const DEFAULT_EXECUTOR_CONFIG = {
  policy: {
    maxConcurrentDelegations: 5,
    maxTtlSeconds: 3600,
    allowedAccessModes: ['ro', 'rw'] as AccessMode[],
    autoAccept: true,
    resultRetentionMs: 30 * 60 * 1000,
  },
  sandbox: {
    cwdOnly: true,
    allowNetwork: true,
    allowExec: true,
  },
} as const;

export interface ResolvedPolicyConstraints {
  maxConcurrentDelegations: number;
  maxTtlSeconds: number;
  allowedAccessModes: AccessMode[];
  autoAccept: boolean;
  resultRetentionMs: number;
}

export interface ResolvedExecutorConfig {
  workDir: string;
  transport: ExecutorTransportAdapter;
  sandbox: SandboxProfile;
  policy: ResolvedPolicyConstraints;
  hooks: ExecutorHooks;
  listeners: ListenerAdapter[];
}

export function resolveExecutorConfig(config: ExecutorConfig): ResolvedExecutorConfig {
  return {
    workDir: config.workDir,
    transport: config.transport,
    sandbox: config.sandbox ?? { ...DEFAULT_EXECUTOR_CONFIG.sandbox },
    policy: {
      maxConcurrentDelegations: config.policy?.maxConcurrentDelegations ?? DEFAULT_EXECUTOR_CONFIG.policy.maxConcurrentDelegations,
      maxTtlSeconds: config.policy?.maxTtlSeconds ?? DEFAULT_EXECUTOR_CONFIG.policy.maxTtlSeconds,
      allowedAccessModes: config.policy?.allowedAccessModes ?? [...DEFAULT_EXECUTOR_CONFIG.policy.allowedAccessModes],
      autoAccept: config.policy?.autoAccept ?? DEFAULT_EXECUTOR_CONFIG.policy.autoAccept,
      resultRetentionMs: config.policy?.resultRetentionMs ?? DEFAULT_EXECUTOR_CONFIG.policy.resultRetentionMs,
    },
    hooks: config.hooks ?? {},
    listeners: config.listeners ?? [],
  };
}
