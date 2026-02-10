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
  isTerminalState,
  createDelegation,

  generateDelegationId,
  PROTOCOL_VERSION,
  AwcpError,
  WorkspaceNotFoundError,
  WorkspaceInvalidError,
} from '@awcp/core';
import { type DelegatorConfig, type ResolvedDelegatorConfig, resolveDelegatorConfig } from './config.js';
import { AdmissionController } from './admission.js';
import { DelegationManager } from './delegation-manager.js';
import { EnvironmentManager } from './environment-manager.js';
import { ExecutorClient, type TaskEventStream } from './executor-client.js';
import { SnapshotManager } from './snapshot-manager.js';

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
    });

    const { requestTimeout, sseMaxRetries, sseRetryDelayMs } = this.config.delegation.connection;
    this.executorClient = new ExecutorClient(requestTimeout, sseMaxRetries, sseRetryDelayMs);
    this.startCleanupTimer();
  }

  async initialize(): Promise<void> {
    await this.transport.initialize?.();

    const persistedDelegations = await this.delegationManager.loadAll();
    const knownIds = new Set(persistedDelegations.map(d => d.id));

    await this.environmentManager.cleanupStale(knownIds);
    await this.snapshotManager.cleanupStale(knownIds);

    for (const delegation of persistedDelegations) {
      this.delegations.set(delegation.id, delegation);
      this.stateMachines.set(delegation.id, new DelegationStateMachine(delegation.state));
    }
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    await this.transport.shutdown?.();

    for (const id of this.delegations.keys()) {
      await this.environmentManager.release(id).catch(() => {});
      await this.snapshotManager.cleanupDelegation(id).catch(() => {});
    }

    this.delegations.clear();
    this.stateMachines.clear();
  }

  async delegate(params: DelegateParams): Promise<string> {
    const delegationId = generateDelegationId();

    for (const resource of params.environment.resources) {
      const sourcePath = await this.validateAndNormalizePath(resource.source, delegationId);
      resource.source = sourcePath;

      await this.admissionController.check(sourcePath, delegationId);
      await this.config.hooks.onAdmissionCheck?.(sourcePath);
    }

    const ttlSeconds = params.ttlSeconds ?? this.config.delegation.lease.ttlSeconds;
    const accessMode = params.accessMode ?? this.config.delegation.lease.accessMode;
    const snapshotMode = params.snapshotMode ?? this.config.delegation.snapshot.mode;

    try {
      const { envRoot } = await this.environmentManager.build(delegationId, params.environment);

      const delegation = createDelegation({
        id: delegationId,
        peerUrl: params.executorUrl,
        environment: params.environment,
        task: params.task,
        leaseConfig: { ttlSeconds, accessMode },
        snapshotPolicy: {
          mode: snapshotMode,
          retentionMs: this.config.delegation.snapshot.retentionMs,
          maxSnapshots: this.config.delegation.snapshot.maxSnapshots,
        },
        exportPath: envRoot,
      });

      const stateMachine = new DelegationStateMachine();

      this.delegations.set(delegationId, delegation);
      this.stateMachines.set(delegationId, stateMachine);

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
      await this.release(delegationId);
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

    const result = this.transitionState(message.delegationId, { type: 'RECEIVE_ACCEPT', message });
    if (!result.success) {
      throw new Error(
        `Cannot accept delegation ${message.delegationId} in state '${delegation.state}': ${result.error}`
      );
    }

    delegation.executorWorkDir = message.executorWorkDir;
    delegation.executorConstraints = message.executorConstraints;

    const { workDirInfo } = await this.transport.prepare({
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
      workDir: workDirInfo,
    };

    const stream = await this.executorClient.connectTaskEvents(delegation.peerUrl, delegation.id);

    try {
      this.transitionState(delegation.id, { type: 'SEND_START', message: startMessage });
      delegation.activeLease = startMessage.lease;

      await this.executorClient.sendStart(delegation.peerUrl, startMessage);
    } catch (error) {
      stream.abort();
      throw error;
    }

    this.config.hooks.onDelegationStarted?.(delegation);

    console.log(`[AWCP:Delegator] START sent for ${delegation.id}, consuming SSE events...`);
    this.consumeTaskEvents(delegation.id, stream).catch((error) => {
      console.error(`[AWCP:Delegator] SSE error for ${delegation.id}:`, error);
    });
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
        this.delegations.set(delegationId, current);
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
    if (this.transport.capabilities.liveSync) return;

    const delegation = this.delegations.get(delegationId);
    if (!delegation) return;

    const policy = delegation.snapshotPolicy ?? {
      mode: this.config.delegation.snapshot.mode,
      retentionMs: this.config.delegation.snapshot.retentionMs,
      maxSnapshots: this.config.delegation.snapshot.maxSnapshots,
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
      const localPath = await this.snapshotManager.save(
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
    await this.persistDelegation(delegationId);

    this.config.hooks.onSnapshotReceived?.(delegation, snapshot);
  }

  private async applySnapshotToWorkspace(delegationId: string, snapshotData: string): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) return;

    if (!delegation.exportPath) return;

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
      throw new Error(
        `Unknown delegation for DONE: ${message.delegationId}` +
        ` (known=[${Array.from(this.delegations.keys()).join(',')}])`
      );
    }

    const stateMachine = this.stateMachines.get(message.delegationId)!;

    if (stateMachine.getState() === 'started') {
      this.transitionState(message.delegationId, { type: 'SETUP_COMPLETE' });
    }

    const result = this.transitionState(message.delegationId, { type: 'RECEIVE_DONE', message });
    if (!result.success) {
      throw new Error(
        `Cannot complete delegation ${message.delegationId} in state '${delegation.state}': ${result.error}`
      );
    }

    delegation.result = {
      summary: message.finalSummary,
      highlights: message.highlights,
    };
    await this.persistDelegation(delegation.id);

    const shouldReleaseNow = this.transport.capabilities.liveSync
      || this.config.delegation.snapshot.mode === 'auto'
      || this.shouldRelease(delegation);

    if (shouldReleaseNow) {
      await this.release(delegation.id);
    }

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

    await this.release(delegation.id);

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
        throw new Error(`Unexpected message type: ${(message as AwcpMessage).type}`);
    }
  }

  async cancel(delegationId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) {
      throw new Error(`Unknown delegation: ${delegationId}`);
    }

    const result = this.transitionState(delegationId, { type: 'CANCEL' });
    if (!result.success) {
      throw new Error(`Cannot cancel delegation in state ${delegation.state}`);
    }

    await this.persistDelegation(delegationId);
    await this.executorClient.sendCancel(delegation.peerUrl, delegationId).catch(console.error);
    await this.release(delegationId);
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

    const snapshotBuffer = await this.snapshotManager.load(delegationId, snapshotId);
    const snapshotBase64 = snapshotBuffer.toString('base64');

    await this.applySnapshotToWorkspace(delegationId, snapshotBase64);

    snapshot.status = 'applied';
    snapshot.appliedAt = new Date().toISOString();
    delegation.appliedSnapshotId = snapshotId;
    delegation.updatedAt = new Date().toISOString();
    await this.persistDelegation(delegationId);

    this.config.hooks.onSnapshotApplied?.(delegation, snapshot);

    if (this.shouldRelease(delegation)) {
      await this.release(delegationId);
    }
  }

  async discardSnapshot(delegationId: string, snapshotId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) throw new Error(`Unknown delegation: ${delegationId}`);

    const snapshot = delegation.snapshots?.find(s => s.id === snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);

    await this.snapshotManager.delete(delegationId, snapshotId);

    snapshot.status = 'discarded';
    snapshot.localPath = undefined;
    delegation.updatedAt = new Date().toISOString();
    await this.persistDelegation(delegationId);

    if (this.shouldRelease(delegation)) {
      await this.release(delegationId);
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

  private shouldRelease(delegation: Delegation): boolean {
    if (!delegation.snapshots || delegation.snapshots.length === 0) {
      return true;
    }
    return delegation.snapshots.every(s => s.status !== 'pending');
  }

  private async release(delegationId: string): Promise<void> {
    await this.transport.release(delegationId);
    await this.environmentManager.release(delegationId);
    await this.snapshotManager.cleanupDelegation(delegationId);
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

        const policy = delegation.snapshotPolicy ?? { retentionMs: this.config.delegation.snapshot.retentionMs };
        const updatedAt = new Date(delegation.updatedAt).getTime();

        if (now - updatedAt > (policy.retentionMs ?? this.config.delegation.snapshot.retentionMs)) {
          await this.release(id);
          await this.delegationManager.delete(id);
          this.delegations.delete(id);
          this.stateMachines.delete(id);
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
