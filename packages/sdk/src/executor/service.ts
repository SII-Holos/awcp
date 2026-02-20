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
  type ActiveLease,
  type ExecutorRequestHandler,
  type ExecutorServiceStatus,
  type TaskExecutor,
  type TaskResultResponse,
  type ChunkStatusResponse,
  type ArchiveWorkDirInfo,
  generateSnapshotId,
  createAssignment,
  PROTOCOL_VERSION,
  ErrorCodes,
  AwcpError,
  CancelledError,
} from '@awcp/core';
import { type ExecutorConfig, type ResolvedExecutorConfig, resolveExecutorConfig } from './config.js';
import type { TaskExecutor } from './config.js';
import type { ExecutorRequestHandler, ExecutorServiceStatus, TaskResultResponse } from '../listener/types.js';
import { AdmissionController } from './admission.js';
import { AssignmentManager } from './assignment-manager.js';
import { WorkspaceManager } from './workspace-manager.js';
import type { ArchiveTransport } from '@awcp/transport-archive';

export interface ExecutorServiceOptions {
  executor: TaskExecutor;
  config: ExecutorConfig;
}

export class ExecutorService implements ExecutorRequestHandler {
  private config: ResolvedExecutorConfig;
  private transport: ExecutorTransportAdapter;
  private workspace: WorkspaceManager;
  private pendingInvitations = new Map<string, PendingInvitation>();
  private activeDelegations = new Map<string, ActiveDelegation>();
  private completedDelegations = new Map<string, CompletedDelegation>();
  // Resolvers for waiting on chunk completion
  private chunkCompletionResolvers = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
  }>();

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

    if (this.config.cleanupOnInitialize) {
      const persistedAssignments = await this.assignmentManager.loadAll();
      for (const assignment of persistedAssignments) {
        await this.transport.release({ delegationId: assignment.id, localPath: assignment.workPath }).catch(() => {});
        await this.workspaceManager.release(assignment.workPath);
        await this.assignmentManager.delete(assignment.id).catch(() => {});
      }
      this.startCleanupTimer();
      return;
    }

    const persistedAssignments = await this.assignmentManager.loadAll();
    const knownIds = new Set(persistedAssignments.map(a => a.id));

    for (const assignment of persistedAssignments) {
      this.assignments.set(assignment.id, assignment);
      this.stateMachines.set(assignment.id, new AssignmentStateMachine(assignment.state));
      if (!isTerminalAssignmentState(assignment.state)) {
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

    const existing = this.assignments.get(delegationId);
    if (existing) {
      await this.transport.detach({ delegationId, localPath: existing.workPath }).catch(() => {});
      this.eventEmitters.delete(delegationId);

      const retentionMs = Math.min(invite.retentionMs, this.config.assignment.maxRetentionMs);

      existing.state = 'pending';
      existing.invite = invite;
      existing.retentionMs = retentionMs;

      this.stateMachines.set(delegationId, new AssignmentStateMachine());
      this.eventEmitters.set(delegationId, new EventEmitter());
      await this.persistAssignment(delegationId);

      console.log(`[AWCP:Executor] Re-accepting delegation ${delegationId} (was ${existing.state})`);

      return {
        version: PROTOCOL_VERSION,
        type: 'ACCEPT',
        delegationId,
        retentionMs,
        executorWorkDir: { path: existing.workPath },
        executorConstraints: {
          acceptedAccessMode: invite.lease.accessMode,
          maxTtlSeconds: Math.min(invite.lease.ttlSeconds, this.config.admission.maxTtlSeconds),
          sandboxProfile: this.config.assignment.sandbox,
        },
      };
    }

    await this.admissionController.check({invite, assignments: this.assignments, transport: this.transport});
    await this.config.hooks.onAdmissionCheck?.(invite);

    const retentionMs = Math.min(invite.retentionMs, this.config.assignment.maxRetentionMs);
    const workPath = this.workspaceManager.allocate(delegationId);

    try {
      const assignment = createAssignment({ id: delegationId, invite, workPath, retentionMs });
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
        retentionMs,
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

    this.transitionState(delegationId, { type: 'RECEIVE_START' });

    assignment.lease = start.lease;
    assignment.startedAt = new Date().toISOString();
    await this.persistAssignment(delegationId);

    console.log(
      `[AWCP:Executor] Delegation ${delegationId} started` +
      ` (active=${Array.from(this.assignments.values()).filter(a => a.state === 'active').length}, workPath=${assignment.workPath})`
    );

    // Check if chunked mode
    const workDirInfo = start.workDir as ArchiveWorkDirInfo;
    const isChunked = workDirInfo.transport === 'archive' && !!workDirInfo.chunked;
    
    if (isChunked) {
      const archiveTransport = this.transport as unknown as ArchiveTransport;
      archiveTransport.initChunkReceiver(delegationId, workDirInfo.chunked!);
    }

    // Task execution runs async - don't await
    // IMPORTANT: Don't block here - return immediately so HTTP response is sent
    // Chunked transfer will be awaited inside executeTask
    this.executeTaskWithChunkWait(
      delegationId, start, workPath, pending.invite.task, start.lease, 
      pending.invite.environment, eventEmitter, isChunked
    );
  }

  /**
   * Execute task with optional chunk wait
   * Separated to avoid blocking the HTTP handler
   */
  private async executeTaskWithChunkWait(
    delegationId: string,
    start: StartMessage,
    workPath: string,
    task: TaskSpec,
    lease: ActiveLease,
    environment: EnvironmentDeclaration,
    eventEmitter: EventEmitter,
    isChunked: boolean,
  ): Promise<void> {
    // Wait for chunks if in chunked mode
    if (isChunked) {
      console.log(`[AWCP:Executor] Waiting for chunked transfer: ${delegationId}`);
      try {
        await this.waitForChunks(delegationId);
        console.log(`[AWCP:Executor] Chunked transfer complete: ${delegationId}`);
      } catch (error) {
        console.error(`[AWCP:Executor] Chunked transfer failed: ${delegationId}`, error);

        const errorEvent: TaskErrorEvent = {
          delegationId,
          type: 'error',
          timestamp: new Date().toISOString(),
          code: ErrorCodes.TRANSPORT_ERROR,
          message: error instanceof Error ? error.message : 'Chunked transfer failed',
          hint: 'Check network connection and retry',
        };
        eventEmitter.emit('event', errorEvent);

        this.activeDelegations.delete(delegationId);
        await this.workspace.release(workPath);
        return;
      }
    }

    // Continue with actual task execution
    this.executeTask(delegationId, start, workPath, task, lease, environment, eventEmitter);
  }

  private waitForChunks(delegationId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.chunkCompletionResolvers.has(delegationId)) {
          this.chunkCompletionResolvers.delete(delegationId);
          reject(new Error('Chunked transfer timeout'));
        }
      }, 5 * 60 * 1000); // 5 minute timeout

      this.chunkCompletionResolvers.set(delegationId, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
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

    this.transitionState(delegationId, { type: 'RECEIVE_ERROR' });

    console.log(`[AWCP:Executor] Received ERROR for ${delegationId}: ${error.code} - ${error.message}`);

    assignment.completedAt = new Date().toISOString();
    assignment.error = { code: error.code, message: error.message, hint: error.hint };
    await this.persistAssignment(delegationId);

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
      console.log(`[AWCP:Executor] Task ${delegationId} preparing workspace...`);
      await this.workspaceManager.prepare(assignment.workPath);

      console.log(`[AWCP:Executor] Task ${delegationId} setting up transport (${this.transport.type})...`);
      const actualPath = await this.transport.setup({
        delegationId,
        handle: start.transportHandle,
        localPath: assignment.workPath,
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
      const snapshotResult = await this.transport.captureSnapshot?.({ delegationId, localPath: actualPath });

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

      await this.transport.detach({ delegationId, localPath: assignment.workPath }).catch(() => {});
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

      await this.transport.detach({ delegationId, localPath: assignment.workPath }).catch(() => {});
    }
  }

  async cancelDelegation(delegationId: string): Promise<void> {
    const assignment = this.assignments.get(delegationId);
    if (!assignment) {
      throw new Error(`Delegation not found: ${delegationId}`);
    }

    this.transitionState(delegationId, { type: 'CANCEL' });

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

    await this.transport.detach({ delegationId, localPath: assignment.workPath }).catch(() => {});

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
  ): void {
    const sm = this.stateMachines.get(delegationId)!;
    const assignment = this.assignments.get(delegationId)!;
    const result = sm.transition(event);
    if (!result.success) {
      throw new Error(
        `Cannot transition assignment ${delegationId} (${event.type}) in state '${assignment.state}': ${result.error}`
      );
    }
    assignment.state = sm.getState();
    assignment.updatedAt = new Date().toISOString();
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

        const updatedAt = new Date(assignment.updatedAt).getTime();
        if (now - updatedAt > assignment.retentionMs) {
          await this.transport.release({ delegationId: id, localPath: assignment.workPath }).catch(() => {});
          await this.workspaceManager.release(assignment.workPath);
          await this.assignmentManager.delete(id).catch(() => {});
          this.assignments.delete(id);
          this.stateMachines.delete(id);
          this.eventEmitters.delete(id);
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

  // ========== Chunked Transfer Methods ==========

  async receiveChunk(delegationId: string, index: number, data: string, checksum: string): Promise<void> {
    if (this.transport.type !== 'archive') {
      throw new Error('Chunked transfer only supported for archive transport');
    }

    const archiveTransport = this.transport as unknown as ArchiveTransport;
    await archiveTransport.receiveChunk(delegationId, index, data, checksum);
  }

  async completeChunks(delegationId: string, totalChecksum: string): Promise<void> {
    if (this.transport.type !== 'archive') {
      throw new Error('Chunked transfer only supported for archive transport');
    }

    const archiveTransport = this.transport as unknown as ArchiveTransport;
    await archiveTransport.completeChunks(delegationId, totalChecksum);

    // Resolve the waiting promise
    const resolver = this.chunkCompletionResolvers.get(delegationId);
    if (resolver) {
      this.chunkCompletionResolvers.delete(delegationId);
      resolver.resolve();
    }
  }

  getChunkStatus(delegationId: string): ChunkStatusResponse {
    if (this.transport.type !== 'archive') {
      return { exists: false, received: [], missing: [], complete: false };
    }

    const archiveTransport = this.transport as unknown as ArchiveTransport;
    return archiveTransport.getChunkStatus(delegationId);
  }
}
