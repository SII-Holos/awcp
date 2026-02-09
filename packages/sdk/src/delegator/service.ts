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
  type AwcpMessage,
  type DelegatorTransportAdapter,
  type TaskEvent,
  type TaskSnapshotEvent,
  type DelegatorServiceStatus,
  type DelegatorRequestHandler,
  type DelegateParams,
  type EnvironmentSnapshot,
  DelegationStateMachine,
  createDelegation,
  applyMessageToDelegation,
  generateDelegationId,
  PROTOCOL_VERSION,
  AwcpError,
  WorkspaceTooLargeError,
  WorkspaceNotFoundError,
  WorkspaceInvalidError,
} from '@awcp/core';
import { type DelegatorConfig, type ResolvedDelegatorConfig, resolveDelegatorConfig } from './config.js';
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
  private environmentBuilder: EnvironmentBuilder;
  private snapshotStore: SnapshotStore;
  private executorClient: ExecutorClient;
  private delegations = new Map<string, Delegation>();
  private stateMachines = new Map<string, DelegationStateMachine>();
  private executorUrls = new Map<string, string>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(options: DelegatorServiceOptions) {
    this.config = resolveDelegatorConfig(options.config);
    this.transport = this.config.transport;

    // liveSync transports don't support staged snapshots
    if (this.transport.capabilities.liveSync && this.config.snapshot.mode === 'staged') {
      this.config.snapshot.mode = 'auto';
    }

    this.admissionController = new AdmissionController({
      maxTotalBytes: this.config.admission.maxTotalBytes,
      maxFileCount: this.config.admission.maxFileCount,
      maxSingleFileBytes: this.config.admission.maxSingleFileBytes,
    });

    this.environmentBuilder = new EnvironmentBuilder({
      baseDir: path.join(this.config.baseDir, 'delegations'),
    });

    this.snapshotStore = new SnapshotStore({
      baseDir: this.config.baseDir,
    });

    this.executorClient = new ExecutorClient();
    this.startCleanupTimer();
  }

  async delegate(params: DelegateParams): Promise<string> {
    const delegationId = generateDelegationId();

    for (const resource of params.environment.resources) {
      const sourcePath = await this.validateAndNormalizePath(resource.source, delegationId);
      resource.source = sourcePath;

      const admissionResult = await this.admissionController.check(sourcePath);
      if (!admissionResult.allowed) {
        throw new WorkspaceTooLargeError(
          admissionResult.stats ?? {},
          admissionResult.hint,
          delegationId
        );
      }
    }

    const ttlSeconds = params.ttlSeconds ?? this.config.defaults.ttlSeconds;
    const accessMode = params.accessMode ?? this.config.defaults.accessMode;
    const snapshotMode = params.snapshotMode ?? this.config.snapshot.mode;

    const delegation = createDelegation({
      id: delegationId,
      peerUrl: params.executorUrl,
      environment: params.environment,
      task: params.task,
      leaseConfig: { ttlSeconds, accessMode },
    });

    delegation.snapshotPolicy = {
      mode: snapshotMode,
      retentionMs: this.config.snapshot.retentionMs,
      maxSnapshots: this.config.snapshot.maxSnapshots,
    };

    const { envRoot } = await this.environmentBuilder.build(delegationId, params.environment);
    delegation.exportPath = envRoot;

    const stateMachine = new DelegationStateMachine();

    this.delegations.set(delegationId, delegation);
    this.stateMachines.set(delegationId, stateMachine);
    this.executorUrls.set(delegationId, params.executorUrl);

    const inviteMessage: InviteMessage = {
      version: PROTOCOL_VERSION,
      type: 'INVITE',
      delegationId,
      task: params.task,
      lease: { ttlSeconds, accessMode },
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

    try {
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
      this.config.hooks.onDelegationCreated?.(delegation);

      return delegationId;
    } catch (error) {
      await this.cleanup(delegationId);
      throw error;
    }
  }

  async handleAccept(message: AcceptMessage): Promise<void> {
    const delegation = this.delegations.get(message.delegationId);
    if (!delegation) {
      console.warn(`[AWCP:Delegator] Unknown delegation for ACCEPT: ${message.delegationId}`);
      return;
    }

    const executorUrl = this.executorUrls.get(message.delegationId)!;

    const result = this.transitionState(message.delegationId, { type: 'RECEIVE_ACCEPT', message });
    if (!result.success) {
      console.error(`[AWCP:Delegator] State transition failed: ${result.error}`);
      return;
    }

    const updated = applyMessageToDelegation(delegation, message);
    this.delegations.set(delegation.id, updated);

    const { workDirInfo } = await this.transport.prepare({
      delegationId: delegation.id,
      exportPath: updated.exportPath!,
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

  private async subscribeToTaskEvents(delegationId: string, executorUrl: string): Promise<void> {
    try {
      console.log(`[AWCP:Delegator] Subscribing to SSE for ${delegationId}`);
      for await (const event of this.executorClient.subscribeTask(executorUrl, delegationId)) {
        console.log(`[AWCP:Delegator] SSE event for ${delegationId}: ${event.type}`);
        await this.handleTaskEvent(delegationId, event);
        if (event.type === 'done' || event.type === 'error') {
          break;
        }
      }
    } catch (error) {
      console.error(`[AWCP:Delegator] SSE subscription error for ${delegationId}:`, error);
      const delegation = this.delegations.get(delegationId);
      if (delegation && !['completed', 'error', 'cancelled'].includes(delegation.state)) {
        delegation.state = 'error';
        delegation.error = {
          code: 'SSE_FAILED',
          message: error instanceof Error ? error.message : 'SSE subscription failed',
        };
        this.delegations.set(delegationId, delegation);
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
      const executorUrl = this.executorUrls.get(delegationId);
      if (executorUrl) {
        await this.executorClient.acknowledgeResult(executorUrl, delegationId).catch(() => {});
      }

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
    // liveSync transports don't produce snapshots
    if (this.transport.capabilities.liveSync) return;

    const delegation = this.delegations.get(delegationId);
    if (!delegation) return;

    const policy = delegation.snapshotPolicy ?? {
      mode: this.config.snapshot.mode,
      retentionMs: this.config.snapshot.retentionMs,
      maxSnapshots: this.config.snapshot.maxSnapshots,
    };

    if (!delegation.snapshots) {
      delegation.snapshots = [];
    }

    const snapshot: EnvironmentSnapshot = {
      id: event.snapshotId,
      delegationId,
      summary: event.summary,
      highlights: event.highlights,
      status: 'pending',
      metadata: event.metadata,
      recommended: event.recommended,
      createdAt: new Date().toISOString(),
    };

    if (policy.mode === 'auto') {
      await this.applySnapshotToWorkspace(delegationId, event.snapshotBase64);
      snapshot.status = 'applied';
      snapshot.appliedAt = new Date().toISOString();
      delegation.appliedSnapshotId = event.snapshotId;
    } else if (policy.mode === 'staged') {
      const localPath = await this.snapshotStore.save(
        delegationId,
        event.snapshotId,
        event.snapshotBase64,
        { summary: event.summary, highlights: event.highlights, ...event.metadata }
      );
      snapshot.localPath = localPath;
    } else {
      snapshot.status = 'discarded';
    }

    delegation.snapshots.push(snapshot);
    delegation.updatedAt = new Date().toISOString();

    this.config.hooks.onSnapshotReceived?.(delegation, snapshot);
  }

  private async applySnapshotToWorkspace(delegationId: string, snapshotData: string): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) return;

    if (!this.environmentBuilder.get(delegationId)) return;

    const rwResources = delegation.environment.resources.filter(r => r.mode === 'rw');
    if (rwResources.length === 0) return;

    try {
      if (this.transport.applySnapshot) {
        await this.transport.applySnapshot({
          delegationId,
          snapshotData,
          resources: rwResources.map(r => ({ name: r.name, source: r.source, mode: r.mode })),
        });
        console.log(`[AWCP:Delegator] Applied snapshot for ${delegationId}`);
      }
    } catch (error) {
      console.error(`[AWCP:Delegator] Failed to apply snapshot for ${delegationId}:`, error);
    }
  }

  async handleDone(message: DoneMessage): Promise<void> {
    const delegation = this.delegations.get(message.delegationId);
    if (!delegation) {
      console.warn(`[AWCP:Delegator] Unknown delegation for DONE: ${message.delegationId}`);
      return;
    }

    const stateMachine = this.stateMachines.get(message.delegationId)!;

    if (stateMachine.getState() === 'started') {
      this.transitionState(message.delegationId, { type: 'SETUP_COMPLETE' });
    }

    const result = this.transitionState(message.delegationId, { type: 'RECEIVE_DONE', message });
    if (!result.success) {
      console.error(`[AWCP:Delegator] State transition failed: ${result.error}`);
      return;
    }

    const updated = applyMessageToDelegation(delegation, message);
    this.delegations.set(delegation.id, updated);

    // liveSync transports: cleanup immediately (changes already synced)
    // snapshot transports: cleanup based on policy
    const shouldCleanupNow = this.transport.capabilities.liveSync
      || this.config.snapshot.mode === 'auto'
      || this.shouldCleanup(delegation);

    if (shouldCleanupNow) {
      await this.cleanup(delegation.id);
    }

    this.config.hooks.onDelegationCompleted?.(updated);
  }

  async handleError(message: ErrorMessage): Promise<void> {
    const delegation = this.delegations.get(message.delegationId);
    if (!delegation) {
      console.warn(`[AWCP:Delegator] Unknown delegation for ERROR: ${message.delegationId}`);
      return;
    }

    this.transitionState(message.delegationId, { type: 'RECEIVE_ERROR', message });

    const updated = applyMessageToDelegation(delegation, message);
    this.delegations.set(delegation.id, updated);

    await this.cleanup(delegation.id);

    const error = new AwcpError(
      message.code,
      message.message,
      message.hint,
      delegation.id
    );
    this.config.hooks.onError?.(delegation.id, error);
  }

  async handleMessage(message: AwcpMessage): Promise<void> {
    switch (message.type) {
      case 'ACCEPT':
        await this.handleAccept(message);
        break;
      case 'DONE':
        await this.handleDone(message);
        break;
      case 'ERROR':
        await this.handleError(message);
        break;
      default:
        console.warn(`[AWCP:Delegator] Unexpected message type: ${(message as AwcpMessage).type}`);
    }
  }

  async cancel(delegationId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) {
      throw new Error(`Unknown delegation: ${delegationId}`);
    }

    const executorUrl = this.executorUrls.get(delegationId)!;

    const result = this.transitionState(delegationId, { type: 'CANCEL' });
    if (!result.success) {
      throw new Error(`Cannot cancel delegation in state ${delegation.state}`);
    }

    await this.executorClient.sendCancel(executorUrl, delegationId).catch(console.error);
    await this.cleanup(delegationId);
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

    const snapshot = delegation.snapshots?.find(s => s.id === snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);
    if (snapshot.status === 'applied') throw new Error(`Snapshot already applied: ${snapshotId}`);

    const snapshotBuffer = await this.snapshotStore.load(delegationId, snapshotId);
    const snapshotBase64 = snapshotBuffer.toString('base64');

    await this.applySnapshotToWorkspace(delegationId, snapshotBase64);

    snapshot.status = 'applied';
    snapshot.appliedAt = new Date().toISOString();
    delegation.appliedSnapshotId = snapshotId;
    delegation.updatedAt = new Date().toISOString();

    this.config.hooks.onSnapshotApplied?.(delegation, snapshot);

    if (this.shouldCleanup(delegation)) {
      await this.cleanup(delegationId);
    }
  }

  async discardSnapshot(delegationId: string, snapshotId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) throw new Error(`Unknown delegation: ${delegationId}`);

    const snapshot = delegation.snapshots?.find(s => s.id === snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);

    await this.snapshotStore.delete(delegationId, snapshotId);

    snapshot.status = 'discarded';
    snapshot.localPath = undefined;
    delegation.updatedAt = new Date().toISOString();

    if (this.shouldCleanup(delegation)) {
      await this.cleanup(delegationId);
    }
  }

  async waitForCompletion(delegationId: string, timeoutMs: number = 60000): Promise<Delegation> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const delegation = this.delegations.get(delegationId);
      if (!delegation) {
        throw new Error(`Unknown delegation: ${delegationId}`);
      }

      const stateMachine = this.stateMachines.get(delegationId)!;
      if (stateMachine.isTerminal()) {
        if (delegation.error) {
          throw new AwcpError(
            delegation.error.code,
            delegation.error.message,
            delegation.error.hint,
            delegationId
          );
        }
        return delegation;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error('Timeout waiting for delegation to complete');
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

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  private shouldCleanup(delegation: Delegation): boolean {
    if (!delegation.snapshots || delegation.snapshots.length === 0) {
      return true;
    }
    return delegation.snapshots.every(s => s.status !== 'pending');
  }

  private async cleanup(delegationId: string): Promise<void> {
    await this.transport.cleanup(delegationId);
    await this.environmentBuilder.release(delegationId);
    await this.snapshotStore.cleanupDelegation(delegationId);
    this.executorUrls.delete(delegationId);
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(async () => {
      const now = Date.now();
      for (const [id, delegation] of this.delegations) {
        if (!['completed', 'error', 'cancelled'].includes(delegation.state)) continue;

        const policy = delegation.snapshotPolicy ?? { retentionMs: this.config.snapshot.retentionMs };
        const updatedAt = new Date(delegation.updatedAt).getTime();

        if (now - updatedAt > (policy.retentionMs ?? this.config.snapshot.retentionMs)) {
          await this.cleanup(id);
        }
      }
    }, 60 * 1000);
  }

  private transitionState(
    delegationId: string,
    event: Parameters<DelegationStateMachine['transition']>[0]
  ): ReturnType<DelegationStateMachine['transition']> {
    const sm = this.stateMachines.get(delegationId)!;
    const delegation = this.delegations.get(delegationId)!;
    const result = sm.transition(event);
    if (result.success) {
      delegation.state = sm.getState();
      delegation.updatedAt = new Date().toISOString();
    }
    return result;
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
