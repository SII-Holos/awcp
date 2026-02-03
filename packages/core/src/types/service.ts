/**
 * Service Interfaces
 */

import type {
  AwcpMessage,
  TaskEvent,
  EnvironmentSpec,
  TaskSpec,
  AccessMode,
  AuthCredential,
  Delegation,
} from './messages.js';

// ========== Task Executor ==========

export interface TaskExecutionContext {
  delegationId: string;
  workPath: string;
  task: TaskSpec;
  environment: EnvironmentSpec;
}

export interface TaskExecutionResult {
  summary: string;
  highlights?: string[];
}

export interface TaskExecutor {
  execute(context: TaskExecutionContext): Promise<TaskExecutionResult>;
}

// ========== Executor Service ==========

export interface DelegationStatusInfo {
  id: string;
  workPath: string;
  startedAt: string;
}

export interface ExecutorServiceStatus {
  pendingInvitations: number;
  activeDelegations: number;
  delegations: DelegationStatusInfo[];
}

export interface ExecutorRequestHandler {
  handleMessage(message: AwcpMessage): Promise<AwcpMessage | null>;
  subscribeTask(delegationId: string, callback: (event: TaskEvent) => void): () => void;
  cancelDelegation(delegationId: string): Promise<void>;
  getStatus(): ExecutorServiceStatus;
}

// ========== Delegator Service ==========

export interface DelegateParams {
  executorUrl: string;
  environment: EnvironmentSpec;
  task: TaskSpec;
  ttlSeconds?: number;
  accessMode?: AccessMode;
  auth?: AuthCredential;
}

export interface DelegatorDelegationInfo {
  id: string;
  state: string;
  executorUrl: string;
  environment: EnvironmentSpec;
  createdAt: string;
}

export interface DelegatorServiceStatus {
  activeDelegations: number;
  delegations: DelegatorDelegationInfo[];
}

export interface DelegatorRequestHandler {
  delegate(params: DelegateParams): Promise<string>;
  cancel(delegationId: string): Promise<void>;
  getDelegation(delegationId: string): Delegation | undefined;
  getStatus(): DelegatorServiceStatus;
}
