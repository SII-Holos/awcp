/**
 * AWCP Delegator Service
 *
 * Manages the AWCP delegation protocol on the Delegator side.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  type Delegation,
  type TaskSpec,
  type EnvironmentSpec,
  type InviteMessage,
  type StartMessage,
  type AcceptMessage,
  type DoneMessage,
  type ErrorMessage,
  type AwcpMessage,
  type AccessMode,
  type AuthCredential,
  type DelegatorTransportAdapter,
  type TaskEvent,
  DelegationStateMachine,
  createDelegation,
  applyMessageToDelegation,
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

export interface DelegateParams {
  executorUrl: string;
  environment: EnvironmentSpec;
  task: TaskSpec;
  ttlSeconds?: number;
  accessMode?: AccessMode;
  auth?: AuthCredential;
}

export interface DelegatorServiceStatus {
  activeDelegations: number;
  delegations: Array<{
    id: string;
    state: string;
    executorUrl: string;
    environment: EnvironmentSpec;
    createdAt: string;
  }>;
}

export interface DelegatorServiceOptions {
  config: DelegatorConfig;
}

export class DelegatorService {
  private config: ResolvedDelegatorConfig;
  private transport: DelegatorTransportAdapter;
  private admissionController: AdmissionController;
  private environmentBuilder: EnvironmentBuilder;
  private executorClient: ExecutorClient;
  private delegations = new Map<string, Delegation>();
  private stateMachines = new Map<string, DelegationStateMachine>();
  private executorUrls = new Map<string, string>();

  constructor(options: DelegatorServiceOptions) {
    this.config = resolveDelegatorConfig(options.config);
    this.transport = this.config.transport;

    this.admissionController = new AdmissionController({
      maxTotalBytes: this.config.admission.maxTotalBytes,
      maxFileCount: this.config.admission.maxFileCount,
      maxSingleFileBytes: this.config.admission.maxSingleFileBytes,
    });

    this.environmentBuilder = new EnvironmentBuilder({
      baseDir: this.config.export.baseDir,
    });

    this.executorClient = new ExecutorClient();
  }

  async delegate(params: DelegateParams): Promise<string> {
    const delegationId = randomUUID();

    // Validate and check admission for all resources
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

    const delegation = createDelegation({
      id: delegationId,
      peerUrl: params.executorUrl,
      environment: params.environment,
      task: params.task,
      leaseConfig: { ttlSeconds, accessMode },
    });

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
      environment: params.environment,
      requirements: {
        transport: this.transport.type,
      },
      ...(params.auth && { auth: params.auth }),
    };

    stateMachine.transition({ type: 'SEND_INVITE', message: inviteMessage });
    delegation.state = stateMachine.getState();
    delegation.updatedAt = new Date().toISOString();

    try {
      const response = await this.executorClient.sendInvite(params.executorUrl, inviteMessage);

      if (response.type === 'ERROR') {
        await this.handleError(response);
        throw new AwcpError(
          response.code as any,
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
      console.warn(`[AWCP Delegator] Unknown delegation for ACCEPT: ${message.delegationId}`);
      return;
    }

    const stateMachine = this.stateMachines.get(message.delegationId)!;
    const executorUrl = this.executorUrls.get(message.delegationId)!;

    const result = stateMachine.transition({ type: 'RECEIVE_ACCEPT', message });
    if (!result.success) {
      console.error(`[AWCP Delegator] State transition failed: ${result.error}`);
      return;
    }

    const updated = applyMessageToDelegation(delegation, message);
    updated.state = stateMachine.getState();
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

    stateMachine.transition({ type: 'SEND_START', message: startMessage });
    updated.state = stateMachine.getState();
    updated.activeLease = startMessage.lease;
    updated.updatedAt = new Date().toISOString();
    this.delegations.set(delegation.id, updated);

    await this.executorClient.sendStart(executorUrl, startMessage);
    this.config.hooks.onDelegationStarted?.(updated);

    // Subscribe to SSE events for task completion
    this.subscribeToTaskEvents(delegation.id, executorUrl);
  }

  private async subscribeToTaskEvents(delegationId: string, executorUrl: string): Promise<void> {
    try {
      console.log(`[AWCP Delegator] Subscribing to SSE for ${delegationId}`);
      for await (const event of this.executorClient.subscribeTask(executorUrl, delegationId)) {
        console.log(`[AWCP Delegator] SSE event for ${delegationId}: ${event.type}`);
        await this.handleTaskEvent(delegationId, event);
        if (event.type === 'done' || event.type === 'error') {
          break;
        }
      }
    } catch (error) {
      console.error(`[AWCP Delegator] SSE subscription error for ${delegationId}:`, error);
      // Mark delegation as error if SSE fails and task hasn't completed
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
      stateMachine.transition({ type: 'SETUP_COMPLETE' });
      delegation.state = stateMachine.getState();
      delegation.updatedAt = new Date().toISOString();
      this.delegations.set(delegationId, delegation);
    }

    if (event.type === 'done') {
      if (event.resultBase64) {
        await this.applyResult(delegationId, event.resultBase64);
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

  /**
   * Apply result from Executor back to original workspace
   */
  private async applyResult(delegationId: string, resultBase64: string): Promise<void> {
    try {
      const buffer = Buffer.from(resultBase64, 'base64');
      
      const tempDir = path.join(os.tmpdir(), 'awcp-results');
      await fs.mkdir(tempDir, { recursive: true });
      const archivePath = path.join(tempDir, `${delegationId}-result.zip`);
      await fs.writeFile(archivePath, buffer);

      const extractDir = path.join(tempDir, delegationId);
      await fs.mkdir(extractDir, { recursive: true });

      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(exec);
      await execAsync(`unzip -o "${archivePath}" -d "${extractDir}"`);

      await this.environmentBuilder.applyResult(delegationId, extractDir);

      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

      console.log(`[AWCP Delegator] Applied result for ${delegationId}`);
    } catch (error) {
      console.error(`[AWCP Delegator] Failed to apply result for ${delegationId}:`, error);
    }
  }

  async handleDone(message: DoneMessage): Promise<void> {
    const delegation = this.delegations.get(message.delegationId);
    if (!delegation) {
      console.warn(`[AWCP Delegator] Unknown delegation for DONE: ${message.delegationId}`);
      return;
    }

    const stateMachine = this.stateMachines.get(message.delegationId)!;

    if (stateMachine.getState() === 'started') {
      stateMachine.transition({ type: 'SETUP_COMPLETE' });
    }

    const result = stateMachine.transition({ type: 'RECEIVE_DONE', message });
    if (!result.success) {
      console.error(`[AWCP Delegator] State transition failed: ${result.error}`);
      return;
    }

    const updated = applyMessageToDelegation(delegation, message);
    updated.state = stateMachine.getState();
    this.delegations.set(delegation.id, updated);

    await this.cleanup(delegation.id);
    this.config.hooks.onDelegationCompleted?.(updated);
  }

  async handleError(message: ErrorMessage): Promise<void> {
    const delegation = this.delegations.get(message.delegationId);
    if (!delegation) {
      console.warn(`[AWCP Delegator] Unknown delegation for ERROR: ${message.delegationId}`);
      return;
    }

    const stateMachine = this.stateMachines.get(message.delegationId)!;
    stateMachine.transition({ type: 'RECEIVE_ERROR', message });

    const updated = applyMessageToDelegation(delegation, message);
    updated.state = stateMachine.getState();
    this.delegations.set(delegation.id, updated);

    await this.cleanup(delegation.id);

    const error = new AwcpError(
      message.code as any,
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
        console.warn(`[AWCP Delegator] Unexpected message type: ${(message as AwcpMessage).type}`);
    }
  }

  async cancel(delegationId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) {
      throw new Error(`Unknown delegation: ${delegationId}`);
    }

    const stateMachine = this.stateMachines.get(delegationId)!;
    const executorUrl = this.executorUrls.get(delegationId)!;

    const result = stateMachine.transition({ type: 'CANCEL' });
    if (!result.success) {
      throw new Error(`Cannot cancel delegation in state ${delegation.state}`);
    }

    await this.executorClient.sendCancel(executorUrl, delegationId).catch(console.error);
    await this.cleanup(delegationId);

    delegation.state = stateMachine.getState();
    delegation.updatedAt = new Date().toISOString();
  }

  getDelegation(delegationId: string): Delegation | undefined {
    return this.delegations.get(delegationId);
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
            delegation.error.code as any,
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

  private async cleanup(delegationId: string): Promise<void> {
    await this.transport.cleanup(delegationId);
    await this.environmentBuilder.release(delegationId);
    this.executorUrls.delete(delegationId);
  }

  /**
   * Validate and normalize the workspace path.
   * - Converts relative paths to absolute paths
   * - Verifies the directory exists
   * - Returns the normalized absolute path
   */
  private async validateAndNormalizePath(localDir: string, delegationId: string): Promise<string> {
    // Normalize to absolute path
    const absolutePath = path.isAbsolute(localDir)
      ? localDir
      : path.resolve(process.cwd(), localDir);

    // Verify directory exists
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
