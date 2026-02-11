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
} from '@awcp/core';
import type { ListenerAdapter, ListenerInfo } from '../listener/types.js';

// ========== Admission ==========

export interface ExecutorAdmissionConfig {
  maxConcurrentDelegations?: number;
  maxTtlSeconds?: number;
  allowedAccessModes?: AccessMode[];
}

// ========== Assignment ==========

export interface AssignmentConfig {
  maxRetentionMs?: number;
  sandbox?: SandboxProfile;
}

// ========== Task Executor ==========

export interface TaskExecutionContext {
  delegationId: string;
  workPath: string;
  task: TaskSpec;
  environment: EnvironmentDeclaration;
}

export interface TaskExecutionResult {
  summary: string;
  highlights?: string[];
}

export interface TaskExecutor {
  execute(context: TaskExecutionContext): Promise<TaskExecutionResult>;
}

// ========== Hooks ==========

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

// ========== Config ==========

export interface ExecutorConfig {
  workDir: string;
  transport: ExecutorTransportAdapter;
  admission?: ExecutorAdmissionConfig;
  assignment?: AssignmentConfig;
  cleanupOnInitialize?: boolean;
  hooks?: ExecutorHooks;
  listeners?: ListenerAdapter[];
}

// ========== Defaults ==========

export const DEFAULT_ADMISSION = {
  maxConcurrentDelegations: 5,
  maxTtlSeconds: 3600,
  allowedAccessModes: ['ro', 'rw'] as AccessMode[],
} as const;

export const DEFAULT_ASSIGNMENT = {
  maxRetentionMs: 7 * 24 * 60 * 60 * 1000,   // 7 days
  sandbox: {
    cwdOnly: true,
    allowNetwork: true,
    allowExec: true,
  },
} as const;

// ========== Resolved ==========

export interface ResolvedExecutorConfig {
  workDir: string;
  transport: ExecutorTransportAdapter;
  admission: Required<ExecutorAdmissionConfig>;
  assignment: {
    maxRetentionMs: number;
    sandbox: Required<SandboxProfile>;
  };
  cleanupOnInitialize: boolean;
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
      maxRetentionMs: config.assignment?.maxRetentionMs ?? DEFAULT_ASSIGNMENT.maxRetentionMs,
      sandbox: {
        cwdOnly: config.assignment?.sandbox?.cwdOnly ?? DEFAULT_ASSIGNMENT.sandbox.cwdOnly,
        allowNetwork: config.assignment?.sandbox?.allowNetwork ?? DEFAULT_ASSIGNMENT.sandbox.allowNetwork,
        allowExec: config.assignment?.sandbox?.allowExec ?? DEFAULT_ASSIGNMENT.sandbox.allowExec,
      },
    },
    cleanupOnInitialize: config.cleanupOnInitialize ?? true,
    hooks: config.hooks ?? {},
    listeners: config.listeners ?? [],
  };
}
