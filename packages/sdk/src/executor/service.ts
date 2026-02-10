/**
 * AWCP Executor Service
 */

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import {
  type InviteMessage,
  type StartMessage,
  type AcceptMessage,
  type ErrorMessage,
  type AwcpMessage,
  type Assignment,
  type ExecutorTransportAdapter,
  type ExecutorConstraints,
  type TaskEvent,
  type TaskStatusEvent,
  type TaskSnapshotEvent,
  type TaskDoneEvent,
  type TaskErrorEvent,
  type ExecutorRequestHandler,
  type ExecutorServiceStatus,
  type TaskExecutor,
  type TaskResultResponse,
  type AssignmentEvent,
  AssignmentStateMachine,
  generateSnapshotId,
  createAssignment,
  PROTOCOL_VERSION,
  ErrorCodes,
  AwcpError,
  CancelledError,
} from '@awcp/core';
import { type ExecutorConfig, type ResolvedExecutorConfig, resolveExecutorConfig } from './config.js';
import { AdmissionController } from './admission.js';
import { AssignmentManager } from './assignment-manager.js';
import { WorkspaceManager } from './workspace-manager.js';

export interface ExecutorServiceOptions {
  executor: TaskExecutor;
  config: ExecutorConfig;
}

export class ExecutorService implements ExecutorRequestHandler {
  private config: ResolvedExecutorConfig;
  private transport: ExecutorTransportAdapter;
  private executor: TaskExecutor;
  private admissionController: AdmissionController;
  private workspaceManager: WorkspaceManager;
  private assignmentManager: AssignmentManager;
  private assignments = new Map<string, Assignment>();
  private stateMachines = new Map<string, AssignmentStateMachine>();
  private eventEmitters = new Map<string, EventEmitter>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(options: ExecutorServiceOptions) {
    this.config = resolveExecutorConfig(options.config);
    this.transport = this.config.transport;

    this.executor = options.executor;

    this.admissionController = new AdmissionController(this.config.admission);
    this.workspaceManager = new WorkspaceManager(this.config.workDir);

    this.assignmentManager = new AssignmentManager({
      baseDir: join(this.config.workDir, '.awcp', 'assignments'),
    });
  }

  async initialize(): Promise<void> {
    await this.transport.initialize?.(this.config.workDir);

    const persistedAssignments = await this.assignmentManager.loadAll();
    const knownIds = new Set(persistedAssignments.map(a => a.id));

    for (const assignment of persistedAssignments) {
      this.assignments.set(assignment.id, assignment);
      this.stateMachines.set(assignment.id, new AssignmentStateMachine(assignment.state));
      if (assignment.state === 'pending' || assignment.state === 'active') {
        this.eventEmitters.set(assignment.id, new EventEmitter());
      }
    }

    await this.workspaceManager.cleanupStale(knownIds);
    this.startCleanupTimer();
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    await this.transport.shutdown?.();

    for (const id of this.assignments.keys()) {
      await this.release(id).catch(() => {});
    }

    this.assignments.clear();
    this.stateMachines.clear();
    this.eventEmitters.clear();
  }

  async handleMessage(message: AwcpMessage): Promise<AwcpMessage | null> {
    try {
      switch (message.type) {
        case 'INVITE':
          return await this.handleInvite(message);
        case 'START':
          await this.handleStart(message);
          return null;
        case 'ERROR':
          await this.handleError(message);
          return null;
        default:
          throw new Error(`Unexpected message type: ${(message as AwcpMessage).type}`);
      }
    } catch (error) {
      if (error instanceof AwcpError) {
        return this.createErrorMessage(
          message.delegationId,
          error.code,
          error.message,
          error.hint,
        );
      }
      throw error;
    }
  }

  private async handleInvite(invite: InviteMessage): Promise<AcceptMessage> {
    const { delegationId } = invite;

    await this.admissionController.check({invite, assignments: this.assignments, transport: this.transport});
    await this.config.hooks.onAdmissionCheck?.(invite);

    const workPath = this.workspaceManager.allocate(delegationId);

    try {
      const validation = this.workspaceManager.validate(workPath);
      if (!validation.valid) {
        throw new AwcpError(
          ErrorCodes.WORKDIR_DENIED,
          validation.reason ?? 'Workspace validation failed',
          'Check workDir configuration',
          delegationId,
        );
      }

      const assignment = createAssignment({ id: delegationId, invite, workPath });
      this.assignments.set(delegationId, assignment);
      this.stateMachines.set(delegationId, new AssignmentStateMachine());
      this.eventEmitters.set(delegationId, new EventEmitter());
      await this.persistAssignment(delegationId);

      const executorConstraints: ExecutorConstraints = {
        acceptedAccessMode: invite.lease.accessMode,
        maxTtlSeconds: Math.min(invite.lease.ttlSeconds, this.config.admission.maxTtlSeconds),
        sandboxProfile: this.config.assignment.sandbox,
      };

      return {
        version: PROTOCOL_VERSION,
        type: 'ACCEPT',
        delegationId,
        executorWorkDir: { path: workPath },
        executorConstraints,
      };
    } catch (error) {
      this.assignments.delete(delegationId);
      this.stateMachines.delete(delegationId);
      this.eventEmitters.delete(delegationId);
      await this.workspaceManager.release(workPath);
      await this.assignmentManager.delete(delegationId).catch(() => {});
      throw error;
    }
  }

  private async handleStart(start: StartMessage): Promise<void> {
    const { delegationId } = start;

    const assignment = this.assignments.get(delegationId);
    if (!assignment) {
      throw new Error(
        `Unknown delegation for START: ${delegationId}` +
        ` (known=[${Array.from(this.assignments.keys()).join(',')}])`
      );
    }

    const result = this.transitionState(delegationId, { type: 'RECEIVE_START' });
    if (!result.success) {
      throw new Error(
        `Cannot START delegation ${delegationId} in state '${assignment.state}': ${result.error}`
      );
    }

    assignment.lease = start.lease;
    assignment.startedAt = new Date().toISOString();
    await this.persistAssignment(delegationId);

    console.log(
      `[AWCP:Executor] Delegation ${delegationId} started` +
      ` (active=${Array.from(this.assignments.values()).filter(a => a.state === 'active').length}, workPath=${assignment.workPath})`
    );

    this.executeTask(delegationId, start);
  }

  private async handleError(error: ErrorMessage): Promise<void> {
    const { delegationId } = error;

    const assignment = this.assignments.get(delegationId);
    if (!assignment) {
      throw new Error(
        `Unknown delegation for ERROR: ${delegationId}` +
        ` (known=[${Array.from(this.assignments.keys()).join(',')}])`
      );
    }

    const result = this.transitionState(delegationId, { type: 'RECEIVE_ERROR' });
    if (!result.success) {
      throw new Error(
        `Cannot process ERROR for delegation ${delegationId} in state '${assignment.state}': ${result.error}`
      );
    }

    console.log(`[AWCP:Executor] Received ERROR for ${delegationId}: ${error.code} - ${error.message}`);

    assignment.completedAt = new Date().toISOString();
    assignment.error = { code: error.code, message: error.message, hint: error.hint };
    await this.persistAssignment(delegationId);

    await this.release(delegationId);

    this.config.hooks.onError?.(
      delegationId,
      new AwcpError(error.code, error.message, error.hint, delegationId)
    );
  }

  subscribeTask(delegationId: string, callback: (event: TaskEvent) => void): () => void {
    const assignment = this.assignments.get(delegationId);
    if (!assignment) {
      console.error(`[AWCP:Executor] SSE subscribe rejected for ${delegationId}: unknown delegation`);
      const errorEvent: TaskErrorEvent = {
        delegationId, type: 'error', timestamp: new Date().toISOString(),
        code: 'NOT_FOUND', message: 'Delegation not found on executor',
      };
      callback(errorEvent);
      return () => {};
    }

    const sm = this.stateMachines.get(delegationId)!;
    if (sm.isTerminal()) {
      console.log(`[AWCP:Executor] SSE reconnect for ${delegationId}, replaying ${assignment.state} event`);
      const event: TaskEvent = assignment.state === 'completed'
        ? {
            delegationId, type: 'done', timestamp: assignment.completedAt!,
            summary: assignment.result?.summary ?? 'Task completed',
            highlights: assignment.result?.highlights,
          }
        : {
            delegationId, type: 'error', timestamp: assignment.completedAt!,
            code: assignment.error?.code ?? ErrorCodes.TASK_FAILED,
            message: assignment.error?.message ?? 'Task failed',
            hint: assignment.error?.hint,
          };
      setImmediate(() => callback(event));
      return () => {};
    }

    const emitter = this.eventEmitters.get(delegationId);
    if (!emitter) {
      console.error(`[AWCP:Executor] SSE subscribe failed for ${delegationId}: no event emitter`);
      return () => {};
    }

    console.log(`[AWCP:Executor] SSE subscriber attached for ${delegationId} (state=${assignment.state})`);
    const handler = (event: TaskEvent) => callback(event);
    emitter.on('event', handler);
    return () => {
      console.log(`[AWCP:Executor] SSE subscriber detached for ${delegationId}`);
      emitter.off('event', handler);
    };
  }

  private async executeTask(delegationId: string, start: StartMessage): Promise<void> {
    const assignment = this.assignments.get(delegationId)!;
    const emitter = this.eventEmitters.get(delegationId)!;

    try {
      console.log(`[AWCP:Executor] Task ${delegationId} preparing workspaceManager...`);
      await this.workspaceManager.prepare(assignment.workPath);

      console.log(`[AWCP:Executor] Task ${delegationId} setting up transport (${this.transport.type})...`);
      const actualPath = await this.transport.setup({
        delegationId,
        workDirInfo: start.workDir,
        workDir: assignment.workPath,
      });

      this.config.hooks.onTaskStart?.({
        delegationId,
        workPath: actualPath,
        task: assignment.invite.task,
        lease: assignment.lease!,
        environment: assignment.invite.environment,
      });

      console.log(`[AWCP:Executor] Task ${delegationId} executing (listeners=${emitter.listenerCount('event')})...`);
      const statusEvent: TaskStatusEvent = {
        delegationId,
        type: 'status',
        timestamp: new Date().toISOString(),
        status: 'running',
        message: 'Task execution started',
      };
      emitter.emit('event', statusEvent);

      const result = await this.executor.execute({
        delegationId,
        workPath: actualPath,
        task: assignment.invite.task,
        environment: assignment.invite.environment,
      });

      console.log(`[AWCP:Executor] Task ${delegationId} completed, capturing snapshot...`);
      const snapshotResult = await this.transport.captureSnapshot?.({ delegationId, workDir: actualPath });

      const snapshotId = generateSnapshotId();

      if (snapshotResult?.snapshotBase64) {
        const snapshotEvent: TaskSnapshotEvent = {
          delegationId,
          type: 'snapshot',
          timestamp: new Date().toISOString(),
          snapshotId,
          summary: result.summary,
          highlights: result.highlights,
          snapshotBase64: snapshotResult.snapshotBase64,
          recommended: true,
        };
        emitter.emit('event', snapshotEvent);
      }

      const doneEvent: TaskDoneEvent = {
        delegationId,
        type: 'done',
        timestamp: new Date().toISOString(),
        summary: result.summary,
        highlights: result.highlights,
        snapshotIds: snapshotResult?.snapshotBase64 ? [snapshotId] : undefined,
        recommendedSnapshotId: snapshotResult?.snapshotBase64 ? snapshotId : undefined,
      };

      emitter.emit('event', doneEvent);
      console.log(
        `[AWCP:Executor] Task ${delegationId} done event emitted` +
        ` (listeners=${emitter.listenerCount('event')})`
      );
      this.config.hooks.onTaskComplete?.(delegationId, result.summary);

      this.transitionState(delegationId, { type: 'TASK_COMPLETE' });
      assignment.completedAt = new Date().toISOString();
      assignment.result = {
        summary: result.summary,
        highlights: result.highlights,
        snapshotBase64: snapshotResult?.snapshotBase64,
      };
      await this.persistAssignment(delegationId);

      await this.release(delegationId);
    } catch (error) {
      console.error(`[AWCP:Executor] Task ${delegationId} failed:`, error instanceof Error ? error.message : error);

      const errorEvent: TaskErrorEvent = {
        delegationId,
        type: 'error',
        timestamp: new Date().toISOString(),
        code: ErrorCodes.TASK_FAILED,
        message: error instanceof Error ? error.message : String(error),
        hint: 'Check task requirements and try again',
      };

      emitter.emit('event', errorEvent);
      console.log(
        `[AWCP:Executor] Task ${delegationId} error event emitted` +
        ` (listeners=${emitter.listenerCount('event')})`
      );
      this.config.hooks.onError?.(
        delegationId,
        error instanceof Error ? error : new Error(String(error))
      );

      this.transitionState(delegationId, { type: 'TASK_FAIL' });
      assignment.completedAt = new Date().toISOString();
      assignment.error = {
        code: ErrorCodes.TASK_FAILED,
        message: error instanceof Error ? error.message : String(error),
        hint: 'Check task requirements and try again',
      };
      await this.persistAssignment(delegationId);

      await this.release(delegationId);
    }
  }

  async cancelDelegation(delegationId: string): Promise<void> {
    const assignment = this.assignments.get(delegationId);
    if (!assignment) {
      throw new Error(`Delegation not found: ${delegationId}`);
    }

    const result = this.transitionState(delegationId, { type: 'CANCEL' });
    if (!result.success) {
      throw new Error(
        `Cannot cancel delegation ${delegationId} in state '${assignment.state}': ${result.error}`
      );
    }

    console.log(`[AWCP:Executor] Cancelling delegation ${delegationId}`);

    const emitter = this.eventEmitters.get(delegationId);
    if (emitter) {
      const errorEvent: TaskErrorEvent = {
        delegationId,
        type: 'error',
        timestamp: new Date().toISOString(),
        code: ErrorCodes.CANCELLED,
        message: 'Delegation cancelled',
      };
      emitter.emit('event', errorEvent);
    }

    assignment.completedAt = new Date().toISOString();
    assignment.error = { code: ErrorCodes.CANCELLED, message: 'Delegation cancelled' };
    await this.persistAssignment(delegationId);

    await this.release(delegationId);

    this.config.hooks.onError?.(
      delegationId,
      new CancelledError('Delegation cancelled by Delegator', undefined, delegationId)
    );
  }

  getStatus(): ExecutorServiceStatus {
    const active = Array.from(this.assignments.values()).filter(a => a.state === 'active');
    return {
      pendingInvitations: Array.from(this.assignments.values()).filter(a => a.state === 'pending').length,
      activeDelegations: active.length,
      completedDelegations: Array.from(this.assignments.values()).filter(a => a.state === 'completed' || a.state === 'error').length,
      delegations: active.map((a) => ({
        id: a.id,
        workPath: a.workPath,
        startedAt: a.startedAt!,
      })),
    };
  }

  getTaskResult(delegationId: string): TaskResultResponse {
    const assignment = this.assignments.get(delegationId);

    if (!assignment) {
      if (this.transport.type === 'sshfs') {
        return { status: 'not_applicable', reason: 'SSHFS transport writes directly to source' };
      }
      return { status: 'not_found' };
    }

    const sm = this.stateMachines.get(delegationId)!;
    if (!sm.isTerminal()) {
      return { status: 'running' };
    }

    if (assignment.state === 'completed') {
      return {
        status: 'completed',
        completedAt: assignment.completedAt,
        summary: assignment.result?.summary,
        highlights: assignment.result?.highlights,
        snapshotBase64: assignment.result?.snapshotBase64,
      };
    }

    return {
      status: 'error',
      completedAt: assignment.completedAt,
      error: assignment.error,
    };
  }

  acknowledgeResult(delegationId: string): void {
    const assignment = this.assignments.get(delegationId);
    const sm = this.stateMachines.get(delegationId);
    if (assignment && sm?.isTerminal()) {
      this.assignments.delete(delegationId);
      this.stateMachines.delete(delegationId);
      this.eventEmitters.delete(delegationId);
      this.assignmentManager.delete(delegationId).catch(() => {});
    }
  }

  private transitionState(
    delegationId: string,
    event: AssignmentEvent,
  ): ReturnType<AssignmentStateMachine['transition']> {
    const sm = this.stateMachines.get(delegationId)!;
    const assignment = this.assignments.get(delegationId)!;
    const result = sm.transition(event);
    if (result.success) {
      assignment.state = sm.getState();
      assignment.updatedAt = new Date().toISOString();
    }
    return result;
  }

  private async release(delegationId: string): Promise<void> {
    const assignment = this.assignments.get(delegationId);
    if (!assignment) return;

    await this.transport.release({ delegationId, workDir: assignment.workPath }).catch(() => {});
    await this.workspaceManager.release(assignment.workPath);
    this.eventEmitters.delete(delegationId);
  }

  private async persistAssignment(delegationId: string): Promise<void> {
    const assignment = this.assignments.get(delegationId);
    if (assignment) {
      await this.assignmentManager.save(assignment);
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(async () => {
      const now = Date.now();
      for (const [id, assignment] of this.assignments) {
        const sm = this.stateMachines.get(id);
        if (!sm?.isTerminal()) continue;

        const completedAt = new Date(assignment.completedAt!).getTime();
        if (now - completedAt > this.config.assignment.resultRetentionMs) {
          this.assignments.delete(id);
          this.stateMachines.delete(id);
          this.eventEmitters.delete(id);
          await this.assignmentManager.delete(id).catch(() => {});
        }
      }
    }, 60 * 1000);
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
