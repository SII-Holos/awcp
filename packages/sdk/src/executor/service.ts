/**
 * AWCP Executor Service
 */

import { EventEmitter } from 'node:events';
import {
  type InviteMessage,
  type StartMessage,
  type AcceptMessage,
  type ErrorMessage,
  type AwcpMessage,
  type TaskSpec,
  type EnvironmentDeclaration,
  type ExecutorConstraints,
  type ExecutorTransportAdapter,
  type TaskEvent,
  type TaskStatusEvent,
  type TaskSnapshotEvent,
  type TaskDoneEvent,
  type TaskErrorEvent,
  type ActiveLease,
  type ExecutorRequestHandler,
  type ExecutorServiceStatus,
  type TaskExecutor,
  type TaskResultResponse,
  generateSnapshotId,
  PROTOCOL_VERSION,
  ErrorCodes,
  AwcpError,
  CancelledError,
} from '@awcp/core';
import { type ExecutorConfig, type ResolvedExecutorConfig, resolveExecutorConfig } from './config.js';
import { WorkspaceManager } from './workspace-manager.js';

interface PendingInvitation {
  invite: InviteMessage;
  receivedAt: Date;
}

interface ActiveDelegation {
  id: string;
  workPath: string;
  task: TaskSpec;
  lease: ActiveLease;
  environment: EnvironmentDeclaration;
  startedAt: Date;
  eventEmitter: EventEmitter;
}

interface CompletedDelegation {
  id: string;
  completedAt: Date;
  state: 'completed' | 'error';
  snapshot?: {
    id: string;
    summary: string;
    highlights?: string[];
    snapshotBase64?: string;
  };
  error?: {
    code: string;
    message: string;
    hint?: string;
  };
}

export interface ExecutorServiceOptions {
  executor: TaskExecutor;
  config: ExecutorConfig;
}

export class ExecutorService implements ExecutorRequestHandler {
  private executor: TaskExecutor;
  private config: ResolvedExecutorConfig;
  private transport: ExecutorTransportAdapter;
  private workspace: WorkspaceManager;
  private pendingInvitations = new Map<string, PendingInvitation>();
  private activeDelegations = new Map<string, ActiveDelegation>();
  private completedDelegations = new Map<string, CompletedDelegation>();

  constructor(options: ExecutorServiceOptions) {
    this.executor = options.executor;
    this.config = resolveExecutorConfig(options.config);
    this.transport = this.config.transport;
    this.workspace = new WorkspaceManager(this.config.workDir);
  }

  async handleMessage(message: AwcpMessage): Promise<AwcpMessage | null> {
    switch (message.type) {
      case 'INVITE':
        return this.handleInvite(message);
      case 'START':
        await this.handleStart(message);
        return null;
      case 'ERROR':
        await this.handleError(message);
        return null;
      default:
        throw new Error(`Unexpected message type: ${(message as AwcpMessage).type}`);
    }
  }

  /**
   * Subscribe to task events via SSE
   */
  subscribeTask(delegationId: string, callback: (event: TaskEvent) => void): () => void {
    const delegation = this.activeDelegations.get(delegationId);
    if (!delegation) {
      const errorEvent: TaskErrorEvent = {
        delegationId,
        type: 'error',
        timestamp: new Date().toISOString(),
        code: 'NOT_FOUND',
        message: 'Delegation not found',
      };
      callback(errorEvent);
      return () => {};
    }

    const handler = (event: TaskEvent) => callback(event);
    delegation.eventEmitter.on('event', handler);

    return () => {
      delegation.eventEmitter.off('event', handler);
    };
  }

  private async handleInvite(invite: InviteMessage): Promise<AcceptMessage | ErrorMessage> {
    const { delegationId } = invite;

    if (this.activeDelegations.size >= this.config.policy.maxConcurrentDelegations) {
      return this.createErrorMessage(
        delegationId,
        ErrorCodes.DECLINED,
        'Maximum concurrent delegations reached',
        'Try again later when current tasks complete'
      );
    }

    const maxTtl = this.config.policy.maxTtlSeconds;
    if (invite.lease.ttlSeconds > maxTtl) {
      return this.createErrorMessage(
        delegationId,
        ErrorCodes.DECLINED,
        `Requested TTL (${invite.lease.ttlSeconds}s) exceeds maximum (${maxTtl}s)`,
        `Request a shorter TTL (max: ${maxTtl}s)`
      );
    }

    const allowedModes = this.config.policy.allowedAccessModes;
    if (!allowedModes.includes(invite.lease.accessMode)) {
      return this.createErrorMessage(
        delegationId,
        ErrorCodes.DECLINED,
        `Access mode '${invite.lease.accessMode}' not allowed`,
        `Allowed modes: ${allowedModes.join(', ')}`
      );
    }

    const depCheck = await this.transport.checkDependency();
    if (!depCheck.available) {
      return this.createErrorMessage(
        delegationId,
        ErrorCodes.DEP_MISSING,
        `Transport ${this.transport.type} is not available`,
        depCheck.hint
      );
    }

    if (this.config.hooks.onInvite) {
      const accepted = await this.config.hooks.onInvite(invite);
      if (!accepted) {
        return this.createErrorMessage(
          delegationId,
          ErrorCodes.DECLINED,
          'Invitation declined by policy',
          'The agent declined this delegation request'
        );
      }
    } else if (!this.config.policy.autoAccept) {
      this.pendingInvitations.set(delegationId, {
        invite,
        receivedAt: new Date(),
      });
      return this.createErrorMessage(
        delegationId,
        ErrorCodes.DECLINED,
        'Manual acceptance required but no hook provided',
        'Configure autoAccept: true or provide onInvite hook'
      );
    }

    const workPath = this.workspace.allocate(delegationId);

    const validation = this.workspace.validate(workPath);
    if (!validation.valid) {
      await this.workspace.release(workPath);
      return this.createErrorMessage(
        delegationId,
        ErrorCodes.WORKDIR_DENIED,
        validation.reason ?? 'Workspace validation failed',
        'Check workDir configuration'
      );
    }

    this.pendingInvitations.set(delegationId, {
      invite,
      receivedAt: new Date(),
    });

    const executorConstraints: ExecutorConstraints = {
      acceptedAccessMode: invite.lease.accessMode,
      maxTtlSeconds: Math.min(invite.lease.ttlSeconds, maxTtl),
      sandboxProfile: this.config.sandbox,
    };

    const acceptMessage: AcceptMessage = {
      version: PROTOCOL_VERSION,
      type: 'ACCEPT',
      delegationId,
      executorWorkDir: { path: workPath },
      executorConstraints,
    };

    return acceptMessage;
  }

  private async handleStart(start: StartMessage): Promise<void> {
    const { delegationId } = start;

    const pending = this.pendingInvitations.get(delegationId);
    if (!pending) {
      console.warn(`[AWCP:Executor] Unknown delegation for START: ${delegationId}`);
      return;
    }

    const workPath = this.workspace.allocate(delegationId);
    this.pendingInvitations.delete(delegationId);

    const eventEmitter = new EventEmitter();

    this.activeDelegations.set(delegationId, {
      id: delegationId,
      workPath,
      task: pending.invite.task,
      lease: start.lease,
      environment: pending.invite.environment,
      startedAt: new Date(),
      eventEmitter,
    });

    // Task execution runs async - don't await
    this.executeTask(delegationId, start, workPath, pending.invite.task, start.lease, pending.invite.environment, eventEmitter);
  }

  private async executeTask(
    delegationId: string,
    start: StartMessage,
    workPath: string,
    task: TaskSpec,
    lease: ActiveLease,
    environment: EnvironmentDeclaration,
    eventEmitter: EventEmitter,
  ): Promise<void> {
    try {
      await this.workspace.prepare(workPath);

      const actualPath = await this.transport.setup({
        delegationId,
        workDirInfo: start.workDir,
        workDir: workPath,
      });

      this.config.hooks.onTaskStart?.({ delegationId, workPath: actualPath, task, lease, environment });

      const statusEvent: TaskStatusEvent = {
        delegationId,
        type: 'status',
        timestamp: new Date().toISOString(),
        status: 'running',
        message: 'Task execution started',
      };
      eventEmitter.emit('event', statusEvent);

      const result = await this.executor.execute({
        delegationId,
        workPath: actualPath,
        task,
        environment,
      });

      const teardownResult = await this.transport.teardown({ delegationId, workDir: actualPath });

      const snapshotId = generateSnapshotId();

      if (teardownResult.snapshotBase64) {
        const snapshotEvent: TaskSnapshotEvent = {
          delegationId,
          type: 'snapshot',
          timestamp: new Date().toISOString(),
          snapshotId,
          summary: result.summary,
          highlights: result.highlights,
          snapshotBase64: teardownResult.snapshotBase64,
          recommended: true,
        };
        eventEmitter.emit('event', snapshotEvent);
      }

      const doneEvent: TaskDoneEvent = {
        delegationId,
        type: 'done',
        timestamp: new Date().toISOString(),
        summary: result.summary,
        highlights: result.highlights,
        snapshotIds: teardownResult.snapshotBase64 ? [snapshotId] : undefined,
        recommendedSnapshotId: teardownResult.snapshotBase64 ? snapshotId : undefined,
      };

      eventEmitter.emit('event', doneEvent);
      this.config.hooks.onTaskComplete?.(delegationId, result.summary);

      this.completedDelegations.set(delegationId, {
        id: delegationId,
        completedAt: new Date(),
        state: 'completed',
        snapshot: teardownResult.snapshotBase64 ? {
          id: snapshotId,
          summary: result.summary,
          highlights: result.highlights,
          snapshotBase64: teardownResult.snapshotBase64,
        } : undefined,
      });
      this.scheduleResultCleanup(delegationId);

      this.activeDelegations.delete(delegationId);
      await this.workspace.release(actualPath);
    } catch (error) {
      const delegation = this.activeDelegations.get(delegationId);
      if (delegation) {
        await this.transport.teardown({ delegationId, workDir: delegation.workPath }).catch(() => {});
        await this.workspace.release(delegation.workPath);
      }

      const errorEvent: TaskErrorEvent = {
        delegationId,
        type: 'error',
        timestamp: new Date().toISOString(),
        code: ErrorCodes.TASK_FAILED,
        message: error instanceof Error ? error.message : String(error),
        hint: 'Check task requirements and try again',
      };

      eventEmitter.emit('event', errorEvent);
      this.config.hooks.onError?.(
        delegationId,
        error instanceof Error ? error : new Error(String(error))
      );

      this.completedDelegations.set(delegationId, {
        id: delegationId,
        completedAt: new Date(),
        state: 'error',
        error: {
          code: ErrorCodes.TASK_FAILED,
          message: error instanceof Error ? error.message : String(error),
          hint: 'Check task requirements and try again',
        },
      });
      this.scheduleResultCleanup(delegationId);

      this.activeDelegations.delete(delegationId);
    }
  }

  private async handleError(error: ErrorMessage): Promise<void> {
    const { delegationId } = error;

    const delegation = this.activeDelegations.get(delegationId);
    if (delegation) {
      await this.transport.teardown({ delegationId, workDir: delegation.workPath }).catch(() => {});
      this.activeDelegations.delete(delegationId);
      await this.workspace.release(delegation.workPath);
    }

    this.pendingInvitations.delete(delegationId);

    this.config.hooks.onError?.(
      delegationId,
      new AwcpError(error.code, error.message, error.hint, delegationId)
    );
  }

  async cancelDelegation(delegationId: string): Promise<void> {
    const delegation = this.activeDelegations.get(delegationId);
    if (delegation) {
      await this.transport.teardown({ delegationId, workDir: delegation.workPath }).catch(() => {});
      
      const errorEvent: TaskErrorEvent = {
        delegationId,
        type: 'error',
        timestamp: new Date().toISOString(),
        code: ErrorCodes.CANCELLED,
        message: 'Delegation cancelled',
      };
      delegation.eventEmitter.emit('event', errorEvent);
      
      this.activeDelegations.delete(delegationId);
      await this.workspace.release(delegation.workPath);
      this.config.hooks.onError?.(
        delegationId,
        new CancelledError('Delegation cancelled by Delegator', undefined, delegationId)
      );
      return;
    }

    if (this.pendingInvitations.has(delegationId)) {
      this.pendingInvitations.delete(delegationId);
      return;
    }

    throw new Error(`Delegation not found: ${delegationId}`);
  }

  getStatus(): ExecutorServiceStatus {
    return {
      pendingInvitations: this.pendingInvitations.size,
      activeDelegations: this.activeDelegations.size,
      completedDelegations: this.completedDelegations.size,
      delegations: Array.from(this.activeDelegations.values()).map((d) => ({
        id: d.id,
        workPath: d.workPath,
        startedAt: d.startedAt.toISOString(),
      })),
    };
  }

  getTaskResult(delegationId: string): TaskResultResponse {
    const active = this.activeDelegations.get(delegationId);
    if (active) {
      return { status: 'running' };
    }

    const completed = this.completedDelegations.get(delegationId);
    if (completed) {
      if (completed.state === 'completed') {
        return {
          status: 'completed',
          completedAt: completed.completedAt.toISOString(),
          summary: completed.snapshot?.summary,
          highlights: completed.snapshot?.highlights,
          snapshotBase64: completed.snapshot?.snapshotBase64,
        };
      }
      return {
        status: 'error',
        completedAt: completed.completedAt.toISOString(),
        error: completed.error,
      };
    }

    if (this.transport.type === 'sshfs') {
      return {
        status: 'not_applicable',
        reason: 'SSHFS transport writes directly to source',
      };
    }

    return { status: 'not_found' };
  }

  acknowledgeResult(delegationId: string): void {
    this.completedDelegations.delete(delegationId);
  }

  private scheduleResultCleanup(delegationId: string): void {
    setTimeout(() => {
      this.completedDelegations.delete(delegationId);
    }, this.config.policy.resultRetentionMs);
  }

  private createErrorMessage(
    delegationId: string,
    code: string,
    message: string,
    hint?: string
  ): ErrorMessage {
    return {
      version: PROTOCOL_VERSION,
      type: 'ERROR',
      delegationId,
      code,
      message,
      hint,
    };
  }
}
