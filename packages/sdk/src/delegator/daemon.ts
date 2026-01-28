import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  type Delegation,
  type TaskSpec,
  type LeaseConfig,
  type AcceptMessage,
  type DoneMessage,
  type ErrorMessage,
  type InviteMessage,
  type StartMessage,
  type MountInfo,
  type AwcpMessage,
  DelegationStateMachine,
  createDelegation,
  applyMessageToDelegation,
  PROTOCOL_VERSION,
  AwcpError,
  ErrorCodes,
  WorkspaceTooLargeError,
} from '@awcp/core';
import { AdmissionController, type AdmissionConfig } from './admission.js';
import { ExportViewManager, type ExportConfig } from './export-view.js';

/**
 * Delegator Daemon configuration
 */
export interface DelegatorDaemonConfig {
  /** Admission control settings */
  admission?: AdmissionConfig;
  /** Export view settings */
  export?: ExportConfig;
  /** Default lease TTL in seconds */
  defaultTtlSeconds?: number;
  /** Callback to send A2A messages */
  sendMessage: (peerUrl: string, message: AwcpMessage) => Promise<void>;
  /** Callback to generate credentials for mount */
  generateCredential: (delegationId: string, ttlSeconds: number) => Promise<{
    credential: string;
    endpoint: MountInfo['endpoint'];
  }>;
  /** Callback to revoke credentials */
  revokeCredential: (delegationId: string) => Promise<void>;
}

/**
 * Events emitted by DelegatorDaemon
 */
export interface DelegatorDaemonEvents {
  'delegation:created': (delegation: Delegation) => void;
  'delegation:started': (delegation: Delegation) => void;
  'delegation:completed': (delegation: Delegation) => void;
  'delegation:error': (delegation: Delegation, error: AwcpError) => void;
  'delegation:cancelled': (delegation: Delegation) => void;
}

/**
 * Delegator Daemon
 * 
 * Manages delegations from the Delegator side.
 * Responsible for:
 * - Creating and tracking delegations
 * - Admission control (preflight checks)
 * - Export view management
 * - Credential lifecycle
 * - State machine management
 */
export class DelegatorDaemon extends EventEmitter {
  private delegations = new Map<string, Delegation>();
  private stateMachines = new Map<string, DelegationStateMachine>();
  private admissionController: AdmissionController;
  private exportManager: ExportViewManager;
  private config: DelegatorDaemonConfig;

  constructor(config: DelegatorDaemonConfig) {
    super();
    this.config = config;
    this.admissionController = new AdmissionController(config.admission);
    this.exportManager = new ExportViewManager(config.export);
  }

  /**
   * Create a new delegation
   * 
   * This is the main entry point for Delegator Agent to initiate collaboration.
   * Performs admission control, creates export view, and sends INVITE.
   */
  async createDelegation(params: {
    peerUrl: string;
    localDir: string;
    task: TaskSpec;
    ttlSeconds?: number;
    accessMode?: 'ro' | 'rw';
  }): Promise<string> {
    const delegationId = randomUUID();
    
    // Step 1: Admission Control (Preflight Checks)
    const admissionResult = await this.admissionController.check(params.localDir);
    if (!admissionResult.allowed) {
      throw new WorkspaceTooLargeError(
        admissionResult.stats ?? {},
        admissionResult.hint,
        delegationId,
      );
    }

    // Step 2: Create delegation record
    const leaseConfig: LeaseConfig = {
      ttlSeconds: params.ttlSeconds ?? this.config.defaultTtlSeconds ?? 3600,
      accessMode: params.accessMode ?? 'rw',
    };

    const delegation = createDelegation({
      id: delegationId,
      peerUrl: params.peerUrl,
      localDir: params.localDir,
      task: params.task,
      leaseConfig,
    });

    // Step 3: Create export view
    const exportPath = await this.exportManager.create(delegationId, params.localDir);
    delegation.exportPath = exportPath;

    // Step 4: Initialize state machine
    const stateMachine = new DelegationStateMachine();
    
    // Step 5: Store delegation
    this.delegations.set(delegationId, delegation);
    this.stateMachines.set(delegationId, stateMachine);

    // Step 6: Send INVITE
    const inviteMessage: InviteMessage = {
      version: PROTOCOL_VERSION,
      type: 'INVITE',
      delegationId,
      task: params.task,
      lease: leaseConfig,
      workspace: {
        exportName: `awcp/${delegationId}`,
      },
      requirements: {
        transport: 'sshfs',
      },
    };

    // Transition state BEFORE sending (to avoid race condition with fast responses)
    stateMachine.transition({ type: 'SEND_INVITE', message: inviteMessage });
    delegation.state = stateMachine.getState();
    delegation.updatedAt = new Date().toISOString();

    await this.config.sendMessage(params.peerUrl, inviteMessage);

    this.emit('delegation:created', delegation);
    
    return delegationId;
  }

  /**
   * Handle incoming message from Executor
   */
  async handleMessage(message: AwcpMessage): Promise<void> {
    const delegation = this.delegations.get(message.delegationId);
    if (!delegation) {
      console.warn(`Unknown delegation: ${message.delegationId}`);
      return;
    }

    const stateMachine = this.stateMachines.get(message.delegationId)!;

    switch (message.type) {
      case 'ACCEPT':
        await this.handleAccept(delegation, stateMachine, message);
        break;
      case 'DONE':
        await this.handleDone(delegation, stateMachine, message);
        break;
      case 'ERROR':
        await this.handleError(delegation, stateMachine, message);
        break;
      default:
        console.warn(`Unexpected message type from Executor: ${message.type}`);
    }
  }

  private async handleAccept(
    delegation: Delegation,
    stateMachine: DelegationStateMachine,
    message: AcceptMessage,
  ): Promise<void> {
    // Transition state
    const result = stateMachine.transition({ type: 'RECEIVE_ACCEPT', message });
    if (!result.success) {
      console.error(`State transition failed: ${result.error}`);
      return;
    }

    // Update delegation
    const updated = applyMessageToDelegation(delegation, message);
    updated.state = stateMachine.getState();
    this.delegations.set(delegation.id, updated);

    // Generate credentials and send START
    const { credential, endpoint } = await this.config.generateCredential(
      delegation.id,
      delegation.leaseConfig.ttlSeconds,
    );

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
      mount: {
        transport: 'sshfs',
        endpoint,
        exportLocator: updated.exportPath!,
        credential,
      },
    };

    // Transition to started BEFORE sending (to avoid race condition)
    stateMachine.transition({ type: 'SEND_START', message: startMessage });
    updated.state = stateMachine.getState();
    updated.activeLease = startMessage.lease;
    updated.updatedAt = new Date().toISOString();
    this.delegations.set(delegation.id, updated);

    await this.config.sendMessage(delegation.peerUrl, startMessage);

    this.emit('delegation:started', updated);
  }

  private async handleDone(
    delegation: Delegation,
    stateMachine: DelegationStateMachine,
    message: DoneMessage,
  ): Promise<void> {
    // Need to transition through 'running' first if we're in 'started'
    if (stateMachine.getState() === 'started') {
      stateMachine.transition({ type: 'MOUNT_COMPLETE' });
    }

    const result = stateMachine.transition({ type: 'RECEIVE_DONE', message });
    if (!result.success) {
      console.error(`State transition failed: ${result.error}`);
      return;
    }

    // Cleanup
    await this.cleanup(delegation.id);

    // Update delegation
    const updated = applyMessageToDelegation(delegation, message);
    updated.state = stateMachine.getState();
    this.delegations.set(delegation.id, updated);

    this.emit('delegation:completed', updated);
  }

  private async handleError(
    delegation: Delegation,
    stateMachine: DelegationStateMachine,
    message: ErrorMessage,
  ): Promise<void> {
    stateMachine.transition({ type: 'RECEIVE_ERROR', message });

    // Cleanup
    await this.cleanup(delegation.id);

    // Update delegation
    const updated = applyMessageToDelegation(delegation, message);
    updated.state = stateMachine.getState();
    this.delegations.set(delegation.id, updated);

    const error = new AwcpError(
      message.code as any,
      message.message,
      message.hint,
      delegation.id,
    );
    this.emit('delegation:error', updated, error);
  }

  /**
   * Cancel a delegation
   */
  async cancelDelegation(delegationId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) {
      throw new Error(`Unknown delegation: ${delegationId}`);
    }

    const stateMachine = this.stateMachines.get(delegationId)!;
    const result = stateMachine.transition({ type: 'CANCEL' });
    
    if (!result.success) {
      throw new Error(`Cannot cancel delegation in state ${delegation.state}`);
    }

    // Send cancel message to Executor
    const errorMessage: ErrorMessage = {
      version: PROTOCOL_VERSION,
      type: 'ERROR',
      delegationId,
      code: ErrorCodes.CANCELLED,
      message: 'Delegation cancelled by Delegator',
    };
    
    await this.config.sendMessage(delegation.peerUrl, errorMessage);

    // Cleanup
    await this.cleanup(delegationId);

    delegation.state = stateMachine.getState();
    delegation.updatedAt = new Date().toISOString();
    this.delegations.set(delegationId, delegation);

    this.emit('delegation:cancelled', delegation);
  }

  /**
   * Get delegation status
   */
  getStatus(delegationId: string): Delegation | undefined {
    return this.delegations.get(delegationId);
  }

  /**
   * Wait for delegation to complete
   */
  async waitForResult(
    delegationId: string,
    timeoutMs: number = 60000,
  ): Promise<Delegation> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) {
      throw new Error(`Unknown delegation: ${delegationId}`);
    }

    const stateMachine = this.stateMachines.get(delegationId)!;
    if (stateMachine.isTerminal()) {
      return delegation;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout waiting for delegation result'));
      }, timeoutMs);

      const onComplete = (d: Delegation) => {
        if (d.id === delegationId) {
          cleanup();
          resolve(d);
        }
      };

      const onError = (d: Delegation, error: AwcpError) => {
        if (d.id === delegationId) {
          cleanup();
          reject(error);
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.off('delegation:completed', onComplete);
        this.off('delegation:error', onError);
        this.off('delegation:cancelled', onComplete);
      };

      this.on('delegation:completed', onComplete);
      this.on('delegation:error', onError);
      this.on('delegation:cancelled', onComplete);
    });
  }

  /**
   * Cleanup resources for a delegation
   */
  private async cleanup(delegationId: string): Promise<void> {
    await this.config.revokeCredential(delegationId);
    await this.exportManager.cleanup(delegationId);
  }

  /**
   * Prune all expired delegations
   */
  async pruneResources(): Promise<number> {
    let pruned = 0;
    
    for (const [id, _delegation] of this.delegations) {
      const stateMachine = this.stateMachines.get(id)!;
      if (stateMachine.isTerminal()) {
        await this.cleanup(id);
        this.delegations.delete(id);
        this.stateMachines.delete(id);
        pruned++;
      }
    }

    return pruned;
  }
}

// Re-export for convenience
export { AdmissionController, type AdmissionConfig } from './admission.js';
export { ExportViewManager, type ExportConfig } from './export-view.js';
