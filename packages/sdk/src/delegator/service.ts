/**
 * AWCP Delegator Service
 *
 * Manages the AWCP delegation protocol on the Delegator side.
 * Integrates credential management and export view creation.
 */

import { randomUUID } from 'node:crypto';
import { CredentialManager } from '@awcp/transport-sshfs';
import {
  type Delegation,
  type TaskSpec,
  type InviteMessage,
  type StartMessage,
  type AcceptMessage,
  type DoneMessage,
  type ErrorMessage,
  type AwcpMessage,
  type AccessMode,
  type AuthCredential,
  DelegationStateMachine,
  createDelegation,
  applyMessageToDelegation,
  PROTOCOL_VERSION,
  AwcpError,
  WorkspaceTooLargeError,
} from '@awcp/core';
import { type DelegatorConfig, type ResolvedDelegatorConfig, resolveDelegatorConfig } from './config.js';
import { AdmissionController } from './admission.js';
import { ExportViewManager } from './export-view.js';
import { ExecutorClient } from './executor-client.js';

/**
 * Parameters for creating a delegation
 */
export interface DelegateParams {
  /** URL of the Executor's AWCP endpoint */
  executorUrl: string;
  /** Local directory to delegate */
  localDir: string;
  /** Task specification */
  task: TaskSpec;
  /** TTL in seconds (uses default if not specified) */
  ttlSeconds?: number;
  /** Access mode (uses default if not specified) */
  accessMode?: AccessMode;
  /** 
   * Optional authentication for paid/restricted Executor services.
   * This will be included in the INVITE message.
   */
  auth?: AuthCredential;
}

/**
 * Service status
 */
export interface DelegatorServiceStatus {
  activeDelegations: number;
  delegations: Array<{
    id: string;
    state: string;
    executorUrl: string;
    localDir: string;
    createdAt: string;
  }>;
}

/**
 * Options for creating the service
 */
export interface DelegatorServiceOptions {
  /** AWCP Delegator configuration */
  config: DelegatorConfig;
  /** Callback URL where Executor will send ACCEPT/DONE/ERROR */
  callbackUrl: string;
}

/**
 * AWCP Delegator Service
 *
 * Manages the AWCP delegation lifecycle from the Delegator side:
 * 1. Creates export view for workspace
 * 2. Sends INVITE to Executor
 * 3. Receives ACCEPT, generates credentials
 * 4. Sends START with credentials
 * 5. Receives DONE/ERROR, cleans up
 */
export class DelegatorService {
  private config: ResolvedDelegatorConfig;
  private callbackUrl: string;
  private admissionController: AdmissionController;
  private exportManager: ExportViewManager;
  private credentialManager: CredentialManager;
  private executorClient: ExecutorClient;
  private delegations = new Map<string, Delegation>();
  private stateMachines = new Map<string, DelegationStateMachine>();
  private executorUrls = new Map<string, string>(); // delegationId -> executorUrl

  constructor(options: DelegatorServiceOptions) {
    this.config = resolveDelegatorConfig(options.config);
    this.callbackUrl = options.callbackUrl;

    this.admissionController = new AdmissionController({
      maxTotalBytes: this.config.admission.maxTotalBytes,
      maxFileCount: this.config.admission.maxFileCount,
      maxSingleFileBytes: this.config.admission.maxSingleFileBytes,
    });

    this.exportManager = new ExportViewManager({
      baseDir: this.config.export.baseDir,
      strategy: this.config.export.strategy,
    });

    this.credentialManager = new CredentialManager({
      keyDir: this.config.ssh.keyDir,
      sshHost: this.config.ssh.host,
      sshPort: this.config.ssh.port,
      sshUser: this.config.ssh.user,
    });

    this.executorClient = new ExecutorClient({
      callbackUrl: this.callbackUrl,
    });
  }

  /**
   * Create a new delegation
   *
   * This sends an INVITE to the Executor and waits for ACCEPT.
   * After ACCEPT, it automatically sends START with credentials.
   *
   * @returns The delegation ID
   */
  async delegate(params: DelegateParams): Promise<string> {
    const delegationId = randomUUID();

    // Step 1: Admission Control
    const admissionResult = await this.admissionController.check(params.localDir);
    if (!admissionResult.allowed) {
      throw new WorkspaceTooLargeError(
        admissionResult.stats ?? {},
        admissionResult.hint,
        delegationId
      );
    }

    // Step 2: Create delegation record
    const ttlSeconds = params.ttlSeconds ?? this.config.defaults.ttlSeconds;
    const accessMode = params.accessMode ?? this.config.defaults.accessMode;

    const delegation = createDelegation({
      id: delegationId,
      peerUrl: params.executorUrl,
      localDir: params.localDir,
      task: params.task,
      leaseConfig: { ttlSeconds, accessMode },
    });

    // Step 3: Create export view
    const exportPath = await this.exportManager.create(delegationId, params.localDir);
    delegation.exportPath = exportPath;

    // Step 4: Initialize state machine
    const stateMachine = new DelegationStateMachine();

    // Step 5: Store delegation
    this.delegations.set(delegationId, delegation);
    this.stateMachines.set(delegationId, stateMachine);
    this.executorUrls.set(delegationId, params.executorUrl);

    // Step 6: Build and send INVITE
    const inviteMessage: InviteMessage = {
      version: PROTOCOL_VERSION,
      type: 'INVITE',
      delegationId,
      task: params.task,
      lease: { ttlSeconds, accessMode },
      workspace: {
        exportName: `awcp/${delegationId}`,
      },
      requirements: {
        transport: 'sshfs',
      },
      // Include auth if provided (for paid/restricted Executor services)
      ...(params.auth && { auth: params.auth }),
    };

    // Transition state
    stateMachine.transition({ type: 'SEND_INVITE', message: inviteMessage });
    delegation.state = stateMachine.getState();
    delegation.updatedAt = new Date().toISOString();

    try {
      // Send INVITE and get response (ACCEPT or ERROR)
      const response = await this.executorClient.sendInvite(params.executorUrl, inviteMessage);

      if (response.type === 'ERROR') {
        // Executor rejected
        await this.handleError(response);
        throw new AwcpError(
          response.code as any,
          response.message,
          response.hint,
          delegationId
        );
      }

      // Got ACCEPT - process it
      await this.handleAccept(response);

      // Call hook
      this.config.hooks.onDelegationCreated?.(delegation);

      return delegationId;
    } catch (error) {
      // Cleanup on error
      await this.cleanup(delegationId);
      throw error;
    }
  }

  /**
   * Handle ACCEPT message from Executor
   *
   * This is called internally after INVITE, or externally via the Express handler.
   */
  async handleAccept(message: AcceptMessage): Promise<void> {
    const delegation = this.delegations.get(message.delegationId);
    if (!delegation) {
      console.warn(`[AWCP Delegator] Unknown delegation for ACCEPT: ${message.delegationId}`);
      return;
    }

    const stateMachine = this.stateMachines.get(message.delegationId)!;
    const executorUrl = this.executorUrls.get(message.delegationId)!;

    // Transition state
    const result = stateMachine.transition({ type: 'RECEIVE_ACCEPT', message });
    if (!result.success) {
      console.error(`[AWCP Delegator] State transition failed: ${result.error}`);
      return;
    }

    // Update delegation
    const updated = applyMessageToDelegation(delegation, message);
    updated.state = stateMachine.getState();
    this.delegations.set(delegation.id, updated);

    // Generate credentials
    const { credential, endpoint } = await this.credentialManager.generateCredential(
      delegation.id,
      delegation.leaseConfig.ttlSeconds
    );

    const expiresAt = new Date(
      Date.now() + delegation.leaseConfig.ttlSeconds * 1000
    ).toISOString();

    // Build START message
    const startMessage: StartMessage = {
      version: PROTOCOL_VERSION,
      type: 'START',
      delegationId: delegation.id,
      lease: {
        expiresAt,
        accessMode: delegation.leaseConfig.accessMode,
      },
      mount: {
        transport: 'sshfs',
        endpoint,
        exportLocator: updated.exportPath!,
        credential,
      },
    };

    // Transition to started
    stateMachine.transition({ type: 'SEND_START', message: startMessage });
    updated.state = stateMachine.getState();
    updated.activeLease = startMessage.lease;
    updated.updatedAt = new Date().toISOString();
    this.delegations.set(delegation.id, updated);

    // Send START
    await this.executorClient.sendStart(executorUrl, startMessage);

    // Call hook
    this.config.hooks.onDelegationStarted?.(updated);
  }

  /**
   * Handle DONE message from Executor
   */
  async handleDone(message: DoneMessage): Promise<void> {
    const delegation = this.delegations.get(message.delegationId);
    if (!delegation) {
      console.warn(`[AWCP Delegator] Unknown delegation for DONE: ${message.delegationId}`);
      return;
    }

    const stateMachine = this.stateMachines.get(message.delegationId)!;

    // Transition through 'running' if needed
    if (stateMachine.getState() === 'started') {
      stateMachine.transition({ type: 'MOUNT_COMPLETE' });
    }

    const result = stateMachine.transition({ type: 'RECEIVE_DONE', message });
    if (!result.success) {
      console.error(`[AWCP Delegator] State transition failed: ${result.error}`);
      return;
    }

    // Update delegation
    const updated = applyMessageToDelegation(delegation, message);
    updated.state = stateMachine.getState();
    this.delegations.set(delegation.id, updated);

    // Cleanup
    await this.cleanup(delegation.id);

    // Call hook
    this.config.hooks.onDelegationCompleted?.(updated);
  }

  /**
   * Handle ERROR message from Executor
   */
  async handleError(message: ErrorMessage): Promise<void> {
    const delegation = this.delegations.get(message.delegationId);
    if (!delegation) {
      console.warn(`[AWCP Delegator] Unknown delegation for ERROR: ${message.delegationId}`);
      return;
    }

    const stateMachine = this.stateMachines.get(message.delegationId)!;
    stateMachine.transition({ type: 'RECEIVE_ERROR', message });

    // Update delegation
    const updated = applyMessageToDelegation(delegation, message);
    updated.state = stateMachine.getState();
    this.delegations.set(delegation.id, updated);

    // Cleanup
    await this.cleanup(delegation.id);

    // Call hook
    const error = new AwcpError(
      message.code as any,
      message.message,
      message.hint,
      delegation.id
    );
    this.config.hooks.onError?.(delegation.id, error);
  }

  /**
   * Handle incoming message from Executor
   */
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

  /**
   * Cancel a delegation
   */
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

    // Request Executor to cancel (unmount) before we revoke keys
    await this.executorClient.sendCancel(executorUrl, delegationId).catch(console.error);

    // Now safe to cleanup (revoke SSH keys)
    await this.cleanup(delegationId);

    delegation.state = stateMachine.getState();
    delegation.updatedAt = new Date().toISOString();
  }

  /**
   * Get delegation status
   */
  getDelegation(delegationId: string): Delegation | undefined {
    return this.delegations.get(delegationId);
  }

  /**
   * Wait for delegation to complete
   */
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

      // Wait a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error('Timeout waiting for delegation to complete');
  }

  /**
   * Get service status
   */
  getStatus(): DelegatorServiceStatus {
    return {
      activeDelegations: this.delegations.size,
      delegations: Array.from(this.delegations.values()).map((d) => ({
        id: d.id,
        state: d.state,
        executorUrl: d.peerUrl,
        localDir: d.localDir,
        createdAt: d.createdAt,
      })),
    };
  }

  /**
   * Cleanup resources for a delegation
   */
  private async cleanup(delegationId: string): Promise<void> {
    await this.credentialManager.revokeCredential(delegationId);
    await this.exportManager.cleanup(delegationId);
    this.executorUrls.delete(delegationId);
  }
}
