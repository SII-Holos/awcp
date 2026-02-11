/**
 * Listener Adapter Interfaces
 */

import type { AwcpMessage, TaskEvent } from '@awcp/core';

// ========== Executor Request Handler ==========

export type TaskResultStatus = 'running' | 'completed' | 'error' | 'not_applicable' | 'not_found';

export interface TaskResultResponse {
  status: TaskResultStatus;
  completedAt?: string;
  summary?: string;
  highlights?: string[];
  snapshotBase64?: string;
  error?: {
    code: string;
    message: string;
    hint?: string;
  };
  reason?: string;
}

export interface DelegationStatusInfo {
  id: string;
  workPath: string;
  startedAt: string;
}

export interface ExecutorServiceStatus {
  pendingInvitations: number;
  activeDelegations: number;
  completedDelegations: number;
  delegations: DelegationStatusInfo[];
}

export interface ExecutorRequestHandler {
  handleMessage(message: AwcpMessage): Promise<AwcpMessage | null>;
  subscribeTask(delegationId: string, callback: (event: TaskEvent) => void): () => void;
  getTaskResult(delegationId: string): TaskResultResponse;
  acknowledgeResult(delegationId: string): void;
  cancelDelegation(delegationId: string): Promise<void>;
  getStatus(): ExecutorServiceStatus;
}

// ========== Listener Adapter ==========

export interface ListenerInfo {
  type: string;
  publicUrl: string;
}

export interface ListenerCallbacks {
  onConnected?: (info: ListenerInfo) => void;
  onDisconnected?: (error?: Error) => void;
  onError?: (error: Error) => void;
}

export interface ListenerAdapter {
  readonly type: string;
  start(handler: ExecutorRequestHandler, callbacks?: ListenerCallbacks): Promise<ListenerInfo | null>;
  stop(): Promise<void>;
}
