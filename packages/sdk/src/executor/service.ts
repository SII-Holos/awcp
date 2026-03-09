/**
 * AWCP Executor Service
 */

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import {
  type InviteMessage,
  type StartMessage,
  type ContinueMessage,
  type CloseMessage,
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
  type TaskRoundDoneEvent,
  type TaskErrorEvent,
  type TaskSpec,
  type AssignmentEvent,
  AssignmentStateMachine,
  isTerminalAssignmentState,
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
        case 'CONTINUE':
          await this.handleContinue(message);
          return null;
        case 'CLOSE':
          await this.handleClose(message);
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
      existing.error = undefined;
      existing.currentRound = 1;
      existing.rounds = [{
        number: 1,
        task: invite.task,
        startedAt: new Date().toISOString(),
      }];

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

  private async handleContinue(message: ContinueMessage): Promise<void> {
    const { delegationId } = message;
    const assignment = this.assignments.get(delegationId);
    if (!assignment) {
      throw new Error(`Unknown delegation for CONTINUE: ${delegationId} (known=[${Array.from(this.assignments.keys()).join(',')}])`);
    }

    this.transitionState(delegationId, { type: 'RECEIVE_CONTINUE' });

    // Save current round result if exists
    const currentRound = assignment.rounds[assignment.rounds.length - 1];
    if (currentRound && !currentRound.completedAt) {
      currentRound.completedAt = new Date().toISOString();
    }

    // Start new round
    assignment.currentRound = message.round;
    assignment.rounds.push({
      number: message.round,
      task: message.task,
      startedAt: new Date().toISOString(),
    });

    if (message.lease) {
      assignment.lease = message.lease;
    }

    await this.persistAssignment(delegationId);

    console.log(`[AWCP:Executor] Starting round ${message.round} for ${delegationId}`);

    // Execute on existing workspace — NO transport.setup() needed
    this.executeRound(delegationId, message.task, message.round);
  }

  private async handleClose(message: CloseMessage): Promise<void> {
    const { delegationId } = message;
    const assignment = this.assignments.get(delegationId);
    if (!assignment) {
      throw new Error(`Unknown delegation for CLOSE: ${delegationId}`);
    }

    this.transitionState(delegationId, { type: 'RECEIVE_CLOSE' });

    assignment.completedAt = new Date().toISOString();
    await this.persistAssignment(delegationId);

    // Emit done event to close SSE stream
    const emitter = this.eventEmitters.get(delegationId);
    if (emitter) {
      const doneEvent: TaskDoneEvent = {
        delegationId,
        type: 'done',
        timestamp: new Date().toISOString(),
        summary: 'Session closed by delegator',
      };
      emitter.emit('event', doneEvent);
    }

    // Final cleanup — use release() (not detach()) to fully tear down transport
    await this.transport.release({ delegationId, localPath: assignment.workPath }).catch(() => {});
    console.log(`[AWCP:Executor] Session closed for ${delegationId}`);
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

      // Store actualPath for later rounds
      assignment.workPath = actualPath;

      this.config.hooks.onTaskStart?.({
        delegationId,
        workPath: actualPath,
        task: assignment.invite.task,
        lease: assignment.lease!,
        environment: assignment.invite.environment,
      });

      console.log(`[AWCP:Executor] Task ${delegationId} executing round 1 (listeners=${emitter.listenerCount('event')})...`);

      // Delegate to _doRound for the actual execution
      await this._doRound(delegationId, assignment.invite.task, 1);

    } catch (error) {
      // Transport setup or workspace prep failed
      console.error(`[AWCP:Executor] Task ${delegationId} setup failed:`, error instanceof Error ? error.message : error);

      const errorEvent: TaskErrorEvent = {
        delegationId,
        type: 'error',
        timestamp: new Date().toISOString(),
        code: ErrorCodes.TASK_FAILED,
        message: error instanceof Error ? error.message : String(error),
        hint: 'Check task requirements and try again',
      };
      emitter.emit('event', errorEvent);

      if (!this.transitionState(delegationId, { type: 'TASK_FAIL' })) {
        return; // Already in terminal state (e.g. cancelled during setup)
      }
      assignment.completedAt = new Date().toISOString();
      assignment.error = {
        code: ErrorCodes.TASK_FAILED,
        message: error instanceof Error ? error.message : String(error),
      };
      await this.persistAssignment(delegationId);
      await this.transport.detach({ delegationId, localPath: assignment.workPath }).catch(() => {});
      this.config.hooks.onError?.(delegationId, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private executeRound(delegationId: string, task: TaskSpec, round: number): void {
    // This runs the executor on the EXISTING workspace, no transport setup
    // Fire and forget (async)
    this._doRound(delegationId, task, round).catch((error) => {
      console.error(`[AWCP:Executor] Round ${round} failed for ${delegationId}:`, error);
    });
  }

  private async _doRound(delegationId: string, task: TaskSpec, round: number): Promise<void> {
    const assignment = this.assignments.get(delegationId)!;
    const emitter = this.eventEmitters.get(delegationId)!;

    try {
      const statusEvent: TaskStatusEvent = {
        delegationId,
        type: 'status',
        timestamp: new Date().toISOString(),
        status: 'running',
        message: `Round ${round} execution started`,
      };
      emitter.emit('event', statusEvent);

      const result = await this.executor.execute({
        delegationId,
        workPath: assignment.workPath,
        task,
        environment: assignment.invite.environment,
      });

      // Capture snapshot
      const snapshotResult = await this.transport.captureSnapshot?.({ delegationId, localPath: assignment.workPath });
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

      // Emit round_done (NOT done — session stays alive)
      const roundDoneEvent: TaskRoundDoneEvent = {
        delegationId,
        type: 'round_done',
        timestamp: new Date().toISOString(),
        round,
        summary: result.summary,
        highlights: result.highlights,
        snapshotIds: snapshotResult?.snapshotBase64 ? [snapshotId] : undefined,
        recommendedSnapshotId: snapshotResult?.snapshotBase64 ? snapshotId : undefined,
      };
      emitter.emit('event', roundDoneEvent);

      if (!this.transitionState(delegationId, { type: 'ROUND_COMPLETE' })) {
        return; // Already in terminal state (e.g. cancelled during LLM call)
      }

      // Update round record (skip if delegation was cancelled mid-flight)
      const currentRoundRecord = assignment.rounds[assignment.rounds.length - 1];
      if (currentRoundRecord) {
        currentRoundRecord.completedAt = new Date().toISOString();
        currentRoundRecord.result = { summary: result.summary, highlights: result.highlights };
      }

      assignment.result = { summary: result.summary, highlights: result.highlights };
      await this.persistAssignment(delegationId);

      // Do NOT detach transport — workspace stays alive for next round
      console.log(`[AWCP:Executor] Round ${round} completed for ${delegationId} (state=idle)`);
      this.config.hooks.onTaskComplete?.(delegationId, result.summary);

    } catch (error) {
      console.error(`[AWCP:Executor] Round ${round} failed for ${delegationId}:`, error instanceof Error ? error.message : error);

      const emitter = this.eventEmitters.get(delegationId)!;
      const errorEvent: TaskErrorEvent = {
        delegationId,
        type: 'error',
        timestamp: new Date().toISOString(),
        code: ErrorCodes.TASK_FAILED,
        message: error instanceof Error ? error.message : String(error),
        hint: 'Check task requirements and try again',
      };
      emitter.emit('event', errorEvent);

      if (!this.transitionState(delegationId, { type: 'TASK_FAIL' })) {
        return; // Already in terminal state (e.g. cancelled during LLM call)
      }
      assignment.completedAt = new Date().toISOString();
      assignment.error = {
        code: ErrorCodes.TASK_FAILED,
        message: error instanceof Error ? error.message : String(error),
        hint: 'Check task requirements and try again',
      };
      await this.persistAssignment(delegationId);
      await this.transport.detach({ delegationId, localPath: assignment.workPath }).catch(() => {});
      this.config.hooks.onError?.(delegationId, error instanceof Error ? error : new Error(String(error)));
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
    const active = Array.from(this.assignments.values()).filter(a => a.state === 'active' || a.state === 'idle');
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
  ): boolean {
    const sm = this.stateMachines.get(delegationId)!;
    const assignment = this.assignments.get(delegationId)!;
    const result = sm.transition(event);
    if (!result.success) {
      // If delegation is already in a terminal state (e.g. cancelled while LLM call was in-flight),
      // log a warning instead of throwing — the late-arriving event is harmless.
      if (sm.isTerminal()) {
        console.warn(
          `[AWCP:Executor] Ignoring late ${event.type} for ${delegationId} (already in terminal state '${assignment.state}')`
        );
        return false;
      }
      throw new Error(
        `Cannot transition assignment ${delegationId} (${event.type}) in state '${assignment.state}': ${result.error}`
      );
    }
    assignment.state = sm.getState();
    assignment.updatedAt = new Date().toISOString();
    return true;
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
}
