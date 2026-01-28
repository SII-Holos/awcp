import { EventEmitter } from 'node:events';
import {
  type InviteMessage,
  type StartMessage,
  type AcceptMessage,
  type DoneMessage,
  type ErrorMessage,
  type AwcpMessage,
  type SandboxProfile,
  type ExecutorConstraints,
  DelegationStateMachine,
  PROTOCOL_VERSION,
  ErrorCodes,
  AwcpError,
  DependencyMissingError,
  MountPointDeniedError,
} from '@awcp/core';
import { LocalPolicy, type PolicyConfig } from './policy.js';

/**
 * Executor Daemon configuration
 */
export interface ExecutorDaemonConfig {
  /** Local policy configuration */
  policy?: PolicyConfig;
  /** Sandbox profile to advertise */
  sandboxProfile?: SandboxProfile;
  /** Callback to send A2A messages */
  sendMessage: (peerUrl: string, message: AwcpMessage) => Promise<void>;
  /** Callback to mount delegator filesystem */
  mount: (params: {
    endpoint: { host: string; port: number; user: string };
    exportLocator: string;
    credential: string;
    mountPoint: string;
    options?: Record<string, string>;
  }) => Promise<void>;
  /** Callback to unmount */
  unmount: (mountPoint: string) => Promise<void>;
  /** Callback to execute task */
  executeTask: (params: {
    delegationId: string;
    mountPoint: string;
    task: { description: string; prompt: string };
  }) => Promise<{ summary: string; highlights?: string[]; notes?: string }>;
}

/**
 * Events emitted by ExecutorDaemon
 */
export interface ExecutorDaemonEvents {
  'invitation:received': (invite: InviteMessage, peerUrl: string) => void;
  'task:started': (delegationId: string, mountPoint: string) => void;
  'task:completed': (delegationId: string, summary: string) => void;
  'task:failed': (delegationId: string, error: AwcpError) => void;
}

/**
 * Pending invitation state
 */
interface PendingInvitation {
  invite: InviteMessage;
  peerUrl: string;
  receivedAt: Date;
}

/**
 * Active delegation state on Executor side
 */
interface ActiveDelegation {
  id: string;
  peerUrl: string;
  mountPoint: string;
  stateMachine: DelegationStateMachine;
  task: { description: string; prompt: string };
}

/**
 * Executor Daemon
 * 
 * Manages delegations from the Executor (Collaborator) side.
 * Responsible for:
 * - Receiving and accepting invitations
 * - Enforcing local security policy
 * - Mounting delegator workspaces
 * - Executing tasks
 * - Reporting results
 */
export class ExecutorDaemon extends EventEmitter {
  private pendingInvitations = new Map<string, PendingInvitation>();
  private activeDelegations = new Map<string, ActiveDelegation>();
  private localPolicy: LocalPolicy;
  private config: ExecutorDaemonConfig;

  constructor(config: ExecutorDaemonConfig) {
    super();
    this.config = config;
    this.localPolicy = new LocalPolicy(config.policy);
  }

  /**
   * Handle incoming message from Delegator
   */
  async handleMessage(message: AwcpMessage, peerUrl: string): Promise<void> {
    switch (message.type) {
      case 'INVITE':
        await this.handleInvite(message, peerUrl);
        break;
      case 'START':
        await this.handleStart(message, peerUrl);
        break;
      case 'ERROR':
        await this.handleError(message);
        break;
      default:
        console.warn(`Unexpected message type from Delegator: ${message.type}`);
    }
  }

  private async handleInvite(invite: InviteMessage, peerUrl: string): Promise<void> {
    // Store pending invitation
    this.pendingInvitations.set(invite.delegationId, {
      invite,
      peerUrl,
      receivedAt: new Date(),
    });

    this.emit('invitation:received', invite, peerUrl);

    // Auto-accept if policy allows (can be overridden)
    // In real implementation, this might require user confirmation
    await this.acceptInvitation(invite.delegationId);
  }

  /**
   * Accept a pending invitation
   */
  async acceptInvitation(
    delegationId: string,
    constraints?: Partial<ExecutorConstraints>,
  ): Promise<void> {
    const pending = this.pendingInvitations.get(delegationId);
    if (!pending) {
      throw new Error(`No pending invitation: ${delegationId}`);
    }

    const { invite, peerUrl } = pending;

    // Step 1: Check dependencies
    const depCheck = await this.checkDependencies(invite.requirements?.transport ?? 'sshfs');
    if (!depCheck.available) {
      const error = new DependencyMissingError(depCheck.missing!, depCheck.hint, delegationId);
      await this.sendError(peerUrl, delegationId, error);
      this.pendingInvitations.delete(delegationId);
      return;
    }

    // Step 2: Determine mount point according to local policy
    const mountPoint = this.localPolicy.allocateMountPoint(delegationId);
    
    // Step 3: Validate mount point
    const mountCheck = await this.localPolicy.validateMountPoint(mountPoint);
    if (!mountCheck.valid) {
      const error = new MountPointDeniedError(mountPoint, mountCheck.reason, delegationId);
      await this.sendError(peerUrl, delegationId, error);
      this.pendingInvitations.delete(delegationId);
      return;
    }

    // Step 4: Build executor constraints
    const executorConstraints: ExecutorConstraints = {
      acceptedAccessMode: constraints?.acceptedAccessMode ?? invite.lease.accessMode,
      maxTtlSeconds: constraints?.maxTtlSeconds ?? invite.lease.ttlSeconds,
      sandboxProfile: constraints?.sandboxProfile ?? this.config.sandboxProfile ?? {
        cwdOnly: true,
        allowNetwork: true,
        allowExec: true,
      },
    };

    // Step 5: Send ACCEPT
    const acceptMessage: AcceptMessage = {
      version: PROTOCOL_VERSION,
      type: 'ACCEPT',
      delegationId,
      executorMount: { mountPoint },
      executorConstraints,
    };

    // Store as active delegation BEFORE sending (to avoid race condition with fast START)
    // Note: Using forceState since state machine events are Delegator-centric
    const stateMachine = new DelegationStateMachine('invited');
    stateMachine.forceState('accepted');  // Executor just sent ACCEPT, now waiting for START
    
    this.activeDelegations.set(delegationId, {
      id: delegationId,
      peerUrl,
      mountPoint,
      stateMachine,
      task: invite.task,
    });

    this.pendingInvitations.delete(delegationId);

    await this.config.sendMessage(peerUrl, acceptMessage);
  }

  /**
   * Decline a pending invitation
   */
  async declineInvitation(delegationId: string, reason?: string): Promise<void> {
    const pending = this.pendingInvitations.get(delegationId);
    if (!pending) {
      throw new Error(`No pending invitation: ${delegationId}`);
    }

    const error = new AwcpError(
      ErrorCodes.DECLINED,
      reason ?? 'Invitation declined',
      undefined,
      delegationId,
    );

    await this.sendError(pending.peerUrl, delegationId, error);
    this.pendingInvitations.delete(delegationId);
  }

  private async handleStart(start: StartMessage, peerUrl: string): Promise<void> {
    const delegation = this.activeDelegations.get(start.delegationId);
    if (!delegation) {
      console.warn(`Unknown delegation for START: ${start.delegationId}`);
      return;
    }

    try {
      // Step 1: Transition state (Executor received START, now starting)
      // Using forceState since state machine events are Delegator-centric
      delegation.stateMachine.forceState('started');

      // Step 2: Ensure mount point exists and is empty
      await this.localPolicy.prepareMountPoint(delegation.mountPoint);

      // Step 3: Mount the delegator filesystem
      await this.config.mount({
        endpoint: start.mount.endpoint,
        exportLocator: start.mount.exportLocator,
        credential: start.mount.credential,
        mountPoint: delegation.mountPoint,
        options: start.mount.mountOptions,
      });

      // Step 4: Transition to running
      delegation.stateMachine.transition({ type: 'MOUNT_COMPLETE' });

      this.emit('task:started', delegation.id, delegation.mountPoint);

      // Step 5: Execute the task
      const result = await this.config.executeTask({
        delegationId: delegation.id,
        mountPoint: delegation.mountPoint,
        task: delegation.task,
      });

      // Step 6: Unmount
      await this.config.unmount(delegation.mountPoint);

      // Step 7: Send DONE
      const doneMessage: DoneMessage = {
        version: PROTOCOL_VERSION,
        type: 'DONE',
        delegationId: delegation.id,
        finalSummary: result.summary,
        highlights: result.highlights,
        notes: result.notes,
      };

      await this.config.sendMessage(peerUrl, doneMessage);
      delegation.stateMachine.forceState('completed');  // Executor sent DONE, task completed

      this.emit('task:completed', delegation.id, result.summary);
      this.activeDelegations.delete(delegation.id);
      
    } catch (error) {
      // Handle failure
      await this.handleTaskFailure(delegation, error as Error);
    }
  }

  private async handleError(error: ErrorMessage): Promise<void> {
    const delegation = this.activeDelegations.get(error.delegationId);
    if (delegation) {
      delegation.stateMachine.transition({ type: 'RECEIVE_ERROR', message: error });
      
      // Cleanup
      try {
        await this.config.unmount(delegation.mountPoint);
      } catch {
        // Ignore unmount errors during cleanup
      }

      this.activeDelegations.delete(error.delegationId);
      
      const awcpError = new AwcpError(
        error.code as any,
        error.message,
        error.hint,
        error.delegationId,
      );
      this.emit('task:failed', error.delegationId, awcpError);
    }

    // Also check pending invitations
    this.pendingInvitations.delete(error.delegationId);
  }

  private async handleTaskFailure(delegation: ActiveDelegation, error: Error): Promise<void> {
    // Try to unmount
    try {
      await this.config.unmount(delegation.mountPoint);
    } catch {
      // Ignore unmount errors during cleanup
    }

    // Send ERROR
    const errorMessage: ErrorMessage = {
      version: PROTOCOL_VERSION,
      type: 'ERROR',
      delegationId: delegation.id,
      code: ErrorCodes.TASK_FAILED,
      message: error.message,
      hint: 'Check task requirements and try again',
    };

    await this.config.sendMessage(delegation.peerUrl, errorMessage);
    delegation.stateMachine.transition({ type: 'SEND_ERROR', message: errorMessage });

    this.activeDelegations.delete(delegation.id);

    const awcpError = new AwcpError(
      ErrorCodes.TASK_FAILED,
      error.message,
      undefined,
      delegation.id,
    );
    this.emit('task:failed', delegation.id, awcpError);
  }

  private async sendError(
    peerUrl: string,
    delegationId: string,
    error: AwcpError,
  ): Promise<void> {
    const errorMessage: ErrorMessage = {
      version: PROTOCOL_VERSION,
      type: 'ERROR',
      delegationId,
      code: error.code,
      message: error.message,
      hint: error.hint,
    };

    await this.config.sendMessage(peerUrl, errorMessage);
  }

  private async checkDependencies(
    transport: string,
  ): Promise<{ available: boolean; missing?: string; hint?: string }> {
    if (transport === 'sshfs') {
      // Check if sshfs is available
      // In real implementation, would exec `which sshfs`
      return { available: true };
    }

    return {
      available: false,
      missing: transport,
      hint: `Transport '${transport}' is not supported`,
    };
  }

  /**
   * Get list of pending invitations
   */
  getPendingInvitations(): Array<{ delegationId: string; task: string; peerUrl: string }> {
    return Array.from(this.pendingInvitations.entries()).map(([id, pending]) => ({
      delegationId: id,
      task: pending.invite.task.description,
      peerUrl: pending.peerUrl,
    }));
  }

  /**
   * Get list of active delegations
   */
  getActiveDelegations(): Array<{ delegationId: string; mountPoint: string; state: string }> {
    return Array.from(this.activeDelegations.entries()).map(([id, delegation]) => ({
      delegationId: id,
      mountPoint: delegation.mountPoint,
      state: delegation.stateMachine.getState(),
    }));
  }
}

export { LocalPolicy, type PolicyConfig } from './policy.js';
