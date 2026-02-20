/**
 * AWCP Delegator Service
 *
 * Manages the AWCP delegation protocol on the Delegator side.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type Delegation,
  type InviteMessage,
  type StartMessage,
  type AcceptMessage,
  type DoneMessage,
  type ErrorMessage,
  type DelegatorTransportAdapter,
  type TaskEvent,
  type TaskSnapshotEvent,
  type EnvironmentSnapshot,
  type EnvironmentSpec,
  DelegationStateMachine,
  isTerminalState,
  createDelegation,

  generateDelegationId,
  PROTOCOL_VERSION,
  AwcpError,
  WorkspaceNotFoundError,
  WorkspaceInvalidError,
} from '@awcp/core';
import { type DelegatorConfig, type ResolvedDelegatorConfig, type DelegateParams, resolveDelegatorConfig } from './config.js';
import { AdmissionController } from './admission.js';
import { EnvironmentBuilder } from './environment-builder.js';
import { ExecutorClient } from './executor-client.js';
import { SnapshotStore } from './snapshot-store.js';
import type { ArchiveTransport } from '@awcp/transport-archive';

export interface DelegatorServiceOptions {
  config: DelegatorConfig;
}

export class DelegatorService implements DelegatorRequestHandler {
  private config: ResolvedDelegatorConfig;
  private transport: DelegatorTransportAdapter;
  private admissionController: AdmissionController;
  private delegationManager: DelegationManager;
  private environmentManager: EnvironmentManager;
  private snapshotManager: SnapshotManager;
  private executorClient: ExecutorClient;
  private delegations = new Map<string, Delegation>();
  private stateMachines = new Map<string, DelegationStateMachine>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(options: DelegatorServiceOptions) {
    this.config = resolveDelegatorConfig(options.config);
    this.transport = this.config.transport;

    if (this.transport.capabilities.liveSync && this.config.delegation.snapshot.mode === 'staged') {
      this.config.delegation.snapshot.mode = 'auto';
    }

    this.admissionController = new AdmissionController(this.config.admission);

    this.delegationManager = new DelegationManager({
      baseDir: path.join(this.config.baseDir, 'delegations'),
    });

    this.environmentManager = new EnvironmentManager({
      baseDir: path.join(this.config.baseDir, 'environments'),
    });

    this.snapshotManager = new SnapshotManager({
      baseDir: path.join(this.config.baseDir, 'snapshots'),
      transport: this.transport,
    });

    const { requestTimeout, sseMaxRetries, sseRetryDelayMs } = this.config.delegation.connection;
    this.executorClient = new ExecutorClient(requestTimeout, sseMaxRetries, sseRetryDelayMs);
    this.startCleanupTimer();
  }

  async initialize(): Promise<void> {
    await this.transport.initialize?.();

    if (this.config.cleanupOnInitialize) {
      const persistedDelegations = await this.delegationManager.loadAll();
      for (const delegation of persistedDelegations) {
        await this.transport.release(delegation.id).catch(() => {});
        await this.environmentManager.release(delegation.id);
        await this.snapshotManager.cleanupDelegation(delegation.id);
        await this.delegationManager.delete(delegation.id).catch(() => {});
      }
      return;
    }

    const persistedDelegations = await this.delegationManager.loadAll();
    const knownIds = new Set(persistedDelegations.map(d => d.id));

    await this.environmentManager.cleanupStale(knownIds);
    await this.snapshotManager.cleanupStale(knownIds);

    for (const delegation of persistedDelegations) {
      this.delegations.set(delegation.id, delegation);
      this.stateMachines.set(delegation.id, new DelegationStateMachine(delegation.state));
    }

    for (const delegation of persistedDelegations) {
      if (isTerminalState(delegation.state)) continue;

      console.log(`[AWCP:Delegator] Auto-resuming delegation ${delegation.id} (state=${delegation.state})`);
      try {
        await this.delegate({
          existingId: delegation.id,
          executorUrl: delegation.peerUrl,
          environment: delegation.environment,
          task: delegation.task,
        });
      } catch (error) {
        console.error(`[AWCP:Delegator] Failed to resume ${delegation.id}:`, error instanceof Error ? error.message : error);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    await this.transport.shutdown?.();

    this.delegations.clear();
    this.stateMachines.clear();
  }

  async delegate(params: DelegateParams): Promise<string> {
    const isResume = !!params.existingId;
    const delegationId = params.existingId ?? generateDelegationId();

    if (isResume) {
      const existing = this.delegations.get(delegationId);
      if (!existing) {
        throw new Error(
          `Cannot resume unknown delegation: ${delegationId}` +
          ` (known=[${Array.from(this.delegations.keys()).join(',')}])`
        );
      }
      if (isTerminalState(existing.state)) {
        throw new Error(
          `Cannot resume terminal delegation: ${delegationId} (state=${existing.state})`
        );
      }

      await this.transport.detach(delegationId).catch(() => {});

      this.stateMachines.set(delegationId, new DelegationStateMachine());
    }

    for (const resource of params.environment.resources) {
      const sourcePath = await this.validateAndNormalizePath(resource.source, delegationId);
      resource.source = sourcePath;

      await this.admissionController.check(sourcePath, delegationId);
      await this.config.hooks.onAdmissionCheck?.(sourcePath);
    }

    const ttlSeconds = params.ttlSeconds ?? this.config.delegation.lease.ttlSeconds;
    const accessMode = params.accessMode ?? this.config.delegation.lease.accessMode;
    const snapshotMode = params.snapshotMode ?? this.config.delegation.snapshot.mode;
    const retentionMs = params.retentionMs ?? this.config.delegation.retentionMs;

    try {
      const { envRoot } = await this.environmentManager.build(delegationId, params.environment);

      if (isResume) {
        const delegation = this.delegations.get(delegationId)!;
        delegation.state = 'created';
        delegation.exportPath = envRoot;
      } else {
        const delegation = createDelegation({
          id: delegationId,
          peerUrl: params.executorUrl,
          environment: params.environment,
          task: params.task,
          leaseConfig: { ttlSeconds, accessMode },
          retentionMs,
          snapshotPolicy: {
            mode: snapshotMode,
            maxSnapshots: this.config.delegation.snapshot.maxSnapshots,
          },
          exportPath: envRoot,
        });

        this.delegations.set(delegationId, delegation);
        this.stateMachines.set(delegationId, new DelegationStateMachine());
      }

      const inviteMessage: InviteMessage = {
        version: PROTOCOL_VERSION,
        type: 'INVITE',
        delegationId,
        task: params.task,
        lease: { ttlSeconds, accessMode },
        retentionMs,
        environment: {
          resources: params.environment.resources.map(r => ({
            name: r.name,
            type: r.type,
            mode: r.mode,
          })),
        },
        requirements: {
          transport: this.transport.type,
        },
        ...(params.auth && { auth: params.auth }),
      };

      this.transitionState(delegationId, { type: 'SEND_INVITE', message: inviteMessage });

      const response = await this.executorClient.sendInvite(params.executorUrl, inviteMessage);

      if (response.type === 'ERROR') {
        await this.handleError(response);
        throw new AwcpError(
          response.code,
          response.message,
          response.hint,
          delegationId
        );
      }

      await this.handleAccept(response);
      this.config.hooks.onDelegationCreated?.(this.delegations.get(delegationId)!);

      return delegationId;
    } catch (error) {
      if (isResume) {
        await this.transport.detach(delegationId).catch(() => {});
        await this.environmentManager.release(delegationId);
      } else {
        this.delegations.delete(delegationId);
        this.stateMachines.delete(delegationId);
        await this.transport.release(delegationId).catch(() => {});
        await this.environmentManager.release(delegationId);
        await this.delegationManager.delete(delegationId).catch(() => {});
      }
      throw error;
    }
  }

  async handleAccept(message: AcceptMessage): Promise<void> {
    const delegation = this.delegations.get(message.delegationId);
    if (!delegation) {
      throw new Error(
        `Unknown delegation for ACCEPT: ${message.delegationId}` +
        ` (known=[${Array.from(this.delegations.keys()).join(',')}])`
      );
    }

    this.transitionState(message.delegationId, { type: 'RECEIVE_ACCEPT', message });

    delegation.executorWorkDir = message.executorWorkDir;
    delegation.executorConstraints = message.executorConstraints;
    delegation.executorRetentionMs = message.retentionMs;

    let stream: Awaited<ReturnType<typeof this.executorClient.connectTaskEvents>> | undefined;

    try {
      const handle = await this.transport.prepare({
        delegationId: delegation.id,
        exportPath: delegation.exportPath!,
        ttlSeconds: delegation.leaseConfig.ttlSeconds,
      });

      const expiresAt = new Date(
        Date.now() + delegation.leaseConfig.ttlSeconds * 1000
      ).toISOString();

      const startMessage: StartMessage = {
        version: PROTOCOL_VERSION,
        type: 'START',
        delegationId: delegation.id,
        lease: {
          expiresAt,
          accessMode: delegation.leaseConfig.accessMode,
        },
        transportHandle: handle,
      };

      stream = await this.executorClient.connectTaskEvents(delegation.peerUrl, delegation.id);

      this.transitionState(delegation.id, { type: 'SEND_START', message: startMessage });
      delegation.activeLease = startMessage.lease;

      await this.executorClient.sendStart(delegation.peerUrl, startMessage);
    } catch (error) {
      stream?.abort();
      await this.transport.detach(delegation.id).catch(() => {});
      throw error;
    }

    this.config.hooks.onDelegationStarted?.(delegation);

    console.log(`[AWCP:Delegator] START sent for ${delegation.id}, consuming SSE events...`);
    this.consumeTaskEvents(delegation.id, stream).catch((error) => {
      console.error(`[AWCP:Delegator] SSE error for ${delegation.id}:`, error);
    });

    const expiresAt = new Date(
      Date.now() + delegation.leaseConfig.ttlSeconds * 1000
    ).toISOString();

    const startMessage: StartMessage = {
      version: PROTOCOL_VERSION,
      type: 'START',
      delegationId: delegation.id,
      lease: {
        expiresAt,
        accessMode: delegation.leaseConfig.accessMode,
      },
      workDir: workDirInfo,
    };

    this.transitionState(delegation.id, { type: 'SEND_START', message: startMessage });
    updated.activeLease = startMessage.lease;
    this.delegations.set(delegation.id, updated);

    await this.executorClient.sendStart(executorUrl, startMessage);

    // Chunked upload
    if (this.transport.type === 'archive') {
      const archiveTransport = this.transport as unknown as ArchiveTransport;
      if (archiveTransport.isChunkedMode(delegation.id)) {
        console.log(`[AWCP:Delegator] Starting chunked upload for ${delegation.id}`);
        try {
          await archiveTransport.uploadChunks(delegation.id, executorUrl);
          console.log(`[AWCP:Delegator] Chunked upload complete for ${delegation.id}`);
        } catch (error) {
          console.error(`[AWCP:Delegator] Chunked upload failed for ${delegation.id}:`, error);
          await this.cleanup(delegation.id);
          throw error;
        }
      }
    }

    this.config.hooks.onDelegationStarted?.(updated);

    this.subscribeToTaskEvents(delegation.id, executorUrl);
  }

  async handleDone(message: DoneMessage): Promise<void> {
    const delegation = this.delegations.get(message.delegationId);
    if (!delegation) {
      throw new Error(
        `Unknown delegation for DONE: ${message.delegationId}` +
        ` (known=[${Array.from(this.delegations.keys()).join(',')}])`
      );
    }

    const stateMachine = this.stateMachines.get(message.delegationId)!;

    if (stateMachine.getState() === 'started') {
      this.transitionState(message.delegationId, { type: 'SETUP_COMPLETE' });
    }

    this.transitionState(message.delegationId, { type: 'RECEIVE_DONE', message });

    delegation.result = {
      summary: message.finalSummary,
      highlights: message.highlights,
    };
    await this.persistDelegation(delegation.id);

    await this.transport.detach(delegation.id).catch(() => {});
    await this.environmentManager.release(delegation.id);

    this.config.hooks.onDelegationCompleted?.(delegation);
  }

  async handleError(message: ErrorMessage): Promise<void> {
    const delegation = this.delegations.get(message.delegationId);
    if (!delegation) {
      throw new Error(
        `Unknown delegation for ERROR: ${message.delegationId}` +
        ` (known=[${Array.from(this.delegations.keys()).join(',')}])`
      );
    }

    console.log(
      `[AWCP:Delegator] Processing error for ${message.delegationId}` +
      ` (state=${delegation.state}): ${message.code} - ${message.message}`
    );

    this.transitionState(message.delegationId, { type: 'RECEIVE_ERROR', message });

    delegation.error = {
      code: message.code,
      message: message.message,
      hint: message.hint,
    };
    await this.persistDelegation(delegation.id);

    const error = new AwcpError(
      message.code,
      message.message,
      message.hint,
      delegation.id
    );
    this.config.hooks.onError?.(delegation.id, error);
  }

  private async consumeTaskEvents(delegationId: string, stream: TaskEventStream): Promise<void> {
    try {
      for await (const event of stream.events) {
        console.log(`[AWCP:Delegator] SSE event for ${delegationId}: type=${event.type}`);
        await this.handleTaskEvent(delegationId, event);
        if (event.type === 'done' || event.type === 'error') {
          console.log(`[AWCP:Delegator] SSE stream ended for ${delegationId} (terminal event: ${event.type})`);
          break;
        }
      }
    } catch (error) {
      console.error(
        `[AWCP:Delegator] SSE connection lost for ${delegationId}:`,
        error instanceof Error ? error.message : error
      );
      const current = this.delegations.get(delegationId);
      if (current && !isTerminalState(current.state)) {
        console.error(`[AWCP:Delegator] Marking ${delegationId} as error (was ${current.state})`);
        current.state = 'error';
        current.error = {
          code: 'SSE_FAILED',
          message: `SSE connection lost: ${error instanceof Error ? error.message : 'unknown error'}`,
        };
        current.updatedAt = new Date().toISOString();
        await this.persistDelegation(delegationId);
      }
    }
  }

  private async handleTaskEvent(delegationId: string, event: TaskEvent): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) return;

    const stateMachine = this.stateMachines.get(delegationId)!;

    if (event.type === 'status' && stateMachine.getState() === 'started') {
      this.transitionState(delegationId, { type: 'SETUP_COMPLETE' });
    }

    if (event.type === 'snapshot') {
      await this.handleSnapshotEvent(delegationId, event);
    }

    if (event.type === 'done') {
      await this.executorClient.acknowledgeResult(delegation.peerUrl, delegationId).catch(() => {});

      const doneMessage: DoneMessage = {
        version: PROTOCOL_VERSION,
        type: 'DONE',
        delegationId,
        finalSummary: event.summary,
        highlights: event.highlights,
      };
      await this.handleDone(doneMessage);
    }

    if (event.type === 'error') {
      console.error(
        `[AWCP:Delegator] Executor reported error for ${delegationId}:` +
        ` code=${event.code}, message=${event.message}`
      );
      const errorMessage: ErrorMessage = {
        version: PROTOCOL_VERSION,
        type: 'ERROR',
        delegationId,
        code: event.code,
        message: event.message,
        hint: event.hint,
      };
      await this.handleError(errorMessage);
    }
  }

  private async handleSnapshotEvent(delegationId: string, event: TaskSnapshotEvent): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) return;

    const snapshot = await this.snapshotManager.receive(delegation, event);
    if (!snapshot) return;

    await this.persistDelegation(delegationId);

    this.config.hooks.onSnapshotReceived?.(delegation, snapshot);
  }

  async cancel(delegationId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) {
      throw new Error(`Unknown delegation: ${delegationId}`);
    }

    this.transitionState(delegationId, { type: 'CANCEL' });

    await this.persistDelegation(delegationId);
    await this.executorClient.sendCancel(delegation.peerUrl, delegationId).catch(console.error);
    await this.transport.detach(delegationId).catch(() => {});
  }

  getDelegation(delegationId: string): Delegation | undefined {
    return this.delegations.get(delegationId);
  }

  listSnapshots(delegationId: string): EnvironmentSnapshot[] {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) throw new Error(`Unknown delegation: ${delegationId}`);
    return delegation.snapshots ?? [];
  }

  async applySnapshot(delegationId: string, snapshotId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) throw new Error(`Unknown delegation: ${delegationId}`);

    const snapshot = await this.snapshotManager.apply(delegation, snapshotId);
    await this.persistDelegation(delegationId);

    this.config.hooks.onSnapshotApplied?.(delegation, snapshot);
  }

  async discardSnapshot(delegationId: string, snapshotId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) throw new Error(`Unknown delegation: ${delegationId}`);

    await this.snapshotManager.discard(delegation, snapshotId);
    await this.persistDelegation(delegationId);
  }

  getStatus(): DelegatorServiceStatus {
    return {
      activeDelegations: this.delegations.size,
      delegations: Array.from(this.delegations.values()).map((d) => ({
        id: d.id,
        state: d.state,
        executorUrl: d.peerUrl,
        environment: d.environment,
        createdAt: d.createdAt,
      })),
    };
  }

  private async persistDelegation(delegationId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (delegation) {
      await this.delegationManager.save(delegation);
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(async () => {
      const now = Date.now();
      for (const [id, delegation] of this.delegations) {
        if (!isTerminalState(delegation.state)) continue;

        const updatedAt = new Date(delegation.updatedAt).getTime();
        if (now - updatedAt > delegation.retentionMs) {
          await this.transport.release(id).catch(() => {});
          await this.environmentManager.release(id);
          await this.snapshotManager.cleanupDelegation(id);
          await this.delegationManager.delete(id).catch(() => {});
          this.delegations.delete(id);
          this.stateMachines.delete(id);
        }
      }
    }, 60 * 1000);
  }

  private transitionState(
    delegationId: string,
    event: Parameters<DelegationStateMachine['transition']>[0]
  ): void {
    const sm = this.stateMachines.get(delegationId)!;
    const delegation = this.delegations.get(delegationId)!;
    const result = sm.transition(event);
    if (!result.success) {
      throw new Error(
        `Cannot transition delegation ${delegationId} (${event.type}) in state '${delegation.state}': ${result.error}`
      );
    }
    delegation.state = sm.getState();
    delegation.updatedAt = new Date().toISOString();
  }

  private async validateAndNormalizePath(localDir: string, delegationId: string): Promise<string> {
    const absolutePath = path.isAbsolute(localDir)
      ? localDir
      : path.resolve(process.cwd(), localDir);

    try {
      const stats = await fs.stat(absolutePath);
      if (!stats.isDirectory()) {
        throw new WorkspaceInvalidError(
          absolutePath,
          'path is not a directory',
          'Provide a valid directory path',
          delegationId
        );
      }
    } catch (error) {
      if (error instanceof WorkspaceInvalidError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new WorkspaceNotFoundError(
          absolutePath,
          'Verify the workspace path is correct',
          delegationId
        );
      }
      throw error;
    }

    return absolutePath;
  }
}
