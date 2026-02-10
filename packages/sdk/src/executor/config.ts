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

export interface AdmissionConfig {
  maxConcurrentDelegations?: number;
  maxTtlSeconds?: number;
  allowedAccessModes?: AccessMode[];
}

export interface AssignmentConfig {
  sandbox?: SandboxProfile;
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
  onAdmissionCheck?: (invite: InviteMessage) => Promise<void>;
  onTaskStart?: (context: TaskStartContext) => void;
  onTaskComplete?: (delegationId: string, summary: string) => void;
  onError?: (delegationId: string, error: Error) => void;
  onListenerConnected?: (info: ListenerInfo) => void;
  onListenerDisconnected?: (type: string, error?: Error) => void;
}

export interface ExecutorConfig {
  workDir: string;
  transport: ExecutorTransportAdapter;
  admission?: AdmissionConfig;
  assignment?: AssignmentConfig;
  hooks?: ExecutorHooks;
  listeners?: ListenerAdapter[];
}

export const DEFAULT_ADMISSION = {
  maxConcurrentDelegations: 5,
  maxTtlSeconds: 3600,
  allowedAccessModes: ['ro', 'rw'] as AccessMode[],
} as const;

export const DEFAULT_ASSIGNMENT = {
  sandbox: {
    cwdOnly: true,
    allowNetwork: true,
    allowExec: true,
  },
  resultRetentionMs: 30 * 60 * 1000,       // 30 minutes
} as const;

export interface ResolvedAssignmentConfig {
  sandbox: SandboxProfile;
  resultRetentionMs: number;
}

export interface ResolvedExecutorConfig {
  workDir: string;
  transport: ExecutorTransportAdapter;
  admission: Required<AdmissionConfig>;
  assignment: ResolvedAssignmentConfig;
  hooks: ExecutorHooks;
  listeners: ListenerAdapter[];
}

export function resolveExecutorConfig(config: ExecutorConfig): ResolvedExecutorConfig {
  return {
    workDir: config.workDir,
    transport: config.transport,
    admission: {
      maxConcurrentDelegations: config.admission?.maxConcurrentDelegations ?? DEFAULT_ADMISSION.maxConcurrentDelegations,
      maxTtlSeconds: config.admission?.maxTtlSeconds ?? DEFAULT_ADMISSION.maxTtlSeconds,
      allowedAccessModes: config.admission?.allowedAccessModes ?? [...DEFAULT_ADMISSION.allowedAccessModes],
    },
    assignment: {
      sandbox: config.assignment?.sandbox ?? { ...DEFAULT_ASSIGNMENT.sandbox },
      resultRetentionMs: config.assignment?.resultRetentionMs ?? DEFAULT_ASSIGNMENT.resultRetentionMs,
    },
    hooks: config.hooks ?? {},
    listeners: config.listeners ?? [],
  };
}
