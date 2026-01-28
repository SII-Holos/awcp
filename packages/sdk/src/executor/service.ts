/**
 * AWCP Executor Service
 *
 * Handles the AWCP delegation protocol on the Executor (Collaborator) side.
 * Integrates with A2A SDK executor for task execution.
 */

import { randomUUID } from 'node:crypto';
import type { Message } from '@a2a-js/sdk';
import {
  DefaultExecutionEventBus,
  type AgentExecutor,
  type AgentExecutionEvent,
} from '@a2a-js/sdk/server';
import { SshfsMountClient } from '@awcp/transport-sshfs';
import {
  type InviteMessage,
  type StartMessage,
  type AcceptMessage,
  type DoneMessage,
  type ErrorMessage,
  type AwcpMessage,
  type TaskSpec,
  type ExecutorConstraints,
  PROTOCOL_VERSION,
  ErrorCodes,
  AwcpError,
} from '@awcp/core';
import { type ExecutorConfig, type ResolvedExecutorConfig, resolveExecutorConfig } from './config.js';
import { LocalPolicy } from './policy.js';
import { DelegatorClient } from './delegator-client.js';

/**
 * Pending invitation state
 */
interface PendingInvitation {
  invite: InviteMessage;
  delegatorUrl: string;
  receivedAt: Date;
}

/**
 * Active delegation state
 */
interface ActiveDelegation {
  id: string;
  delegatorUrl: string;
  mountPoint: string;
  task: TaskSpec;
  startedAt: Date;
}

/**
 * Executor service status
 */
export interface ExecutorServiceStatus {
  pendingInvitations: number;
  activeDelegations: number;
  delegations: Array<{
    id: string;
    mountPoint: string;
    startedAt: string;
  }>;
}

/**
 * Options for creating the service
 */
export interface ExecutorServiceOptions {
  /** A2A agent executor */
  executor: AgentExecutor;
  /** AWCP configuration */
  config: ExecutorConfig;
}

/**
 * AWCP Executor Service
 *
 * Manages the AWCP delegation lifecycle:
 * 1. Receives INVITE from Delegator
 * 2. Sends ACCEPT back
 * 3. Receives START with credentials
 * 4. Mounts workspace via SSHFS
 * 5. Executes task via A2A executor
 * 6. Unmounts and sends DONE/ERROR
 */
export class ExecutorService {
  private executor: AgentExecutor;
  private config: ResolvedExecutorConfig;
  private policy: LocalPolicy;
  private sshfsClient: SshfsMountClient;
  private delegatorClient: DelegatorClient;
  private pendingInvitations = new Map<string, PendingInvitation>();
  private activeDelegations = new Map<string, ActiveDelegation>();

  constructor(options: ExecutorServiceOptions) {
    this.executor = options.executor;
    this.config = resolveExecutorConfig(options.config);
    this.policy = new LocalPolicy({
      mountRoot: this.config.mount.root,
      maxConcurrent: this.config.policy.maxConcurrentDelegations,
    });
    this.sshfsClient = new SshfsMountClient();
    this.delegatorClient = new DelegatorClient();
  }

  /**
   * Handle incoming AWCP message from Delegator
   */
  async handleMessage(
    message: AwcpMessage,
    delegatorUrl: string
  ): Promise<AwcpMessage | null> {
    switch (message.type) {
      case 'INVITE':
        return this.handleInvite(message, delegatorUrl);
      case 'START':
        await this.handleStart(message, delegatorUrl);
        return null;
      case 'ERROR':
        await this.handleError(message);
        return null;
      default:
        throw new Error(`Unexpected message type: ${(message as AwcpMessage).type}`);
    }
  }

  /**
   * Handle INVITE message
   */
  private async handleInvite(
    invite: InviteMessage,
    delegatorUrl: string
  ): Promise<AcceptMessage | ErrorMessage> {
    const { delegationId } = invite;

    // Check if we can accept more delegations
    if (!this.policy.canAcceptMore()) {
      return this.createErrorMessage(
        delegationId,
        ErrorCodes.DECLINED,
        'Maximum concurrent delegations reached',
        'Try again later when current tasks complete'
      );
    }

    // Check TTL constraints
    const maxTtl = this.config.policy.maxTtlSeconds;
    if (invite.lease.ttlSeconds > maxTtl) {
      return this.createErrorMessage(
        delegationId,
        ErrorCodes.DECLINED,
        `Requested TTL (${invite.lease.ttlSeconds}s) exceeds maximum (${maxTtl}s)`,
        `Request a shorter TTL (max: ${maxTtl}s)`
      );
    }

    // Check access mode
    const allowedModes = this.config.policy.allowedAccessModes;
    if (!allowedModes.includes(invite.lease.accessMode)) {
      return this.createErrorMessage(
        delegationId,
        ErrorCodes.DECLINED,
        `Access mode '${invite.lease.accessMode}' not allowed`,
        `Allowed modes: ${allowedModes.join(', ')}`
      );
    }

    // Check dependencies
    const depCheck = await this.sshfsClient.checkDependency();
    if (!depCheck.available) {
      return this.createErrorMessage(
        delegationId,
        ErrorCodes.DEP_MISSING,
        'SSHFS is not available',
        'Install sshfs: brew install macfuse && brew install sshfs (macOS) or apt install sshfs (Linux)'
      );
    }

    // Call onInvite hook if provided
    if (this.config.hooks.onInvite) {
      const accepted = await this.config.hooks.onInvite(invite);
      if (!accepted) {
        return this.createErrorMessage(
          delegationId,
          ErrorCodes.DECLINED,
          'Invitation declined by policy',
          'The agent declined this delegation request'
        );
      }
    } else if (!this.config.policy.autoAccept) {
      // No hook and not auto-accept - store as pending
      this.pendingInvitations.set(delegationId, {
        invite,
        delegatorUrl,
        receivedAt: new Date(),
      });
      // For now, we'll auto-decline if not auto-accept and no hook
      return this.createErrorMessage(
        delegationId,
        ErrorCodes.DECLINED,
        'Manual acceptance required but no hook provided',
        'Configure autoAccept: true or provide onInvite hook'
      );
    }

    // Allocate mount point
    const mountPoint = this.policy.allocateMountPoint(delegationId);

    // Validate mount point
    const validation = await this.policy.validateMountPoint(mountPoint);
    if (!validation.valid) {
      this.policy.releaseMountPoint(mountPoint);
      return this.createErrorMessage(
        delegationId,
        ErrorCodes.MOUNTPOINT_DENIED,
        validation.reason ?? 'Mount point validation failed',
        'Check mount root configuration'
      );
    }

    // Store pending invitation
    this.pendingInvitations.set(delegationId, {
      invite,
      delegatorUrl,
      receivedAt: new Date(),
    });

    // Build executor constraints
    const executorConstraints: ExecutorConstraints = {
      acceptedAccessMode: invite.lease.accessMode,
      maxTtlSeconds: Math.min(invite.lease.ttlSeconds, maxTtl),
      sandboxProfile: this.config.sandbox,
    };

    // Return ACCEPT
    const acceptMessage: AcceptMessage = {
      version: PROTOCOL_VERSION,
      type: 'ACCEPT',
      delegationId,
      executorMount: { mountPoint },
      executorConstraints,
    };

    return acceptMessage;
  }

  /**
   * Handle START message
   */
  private async handleStart(start: StartMessage, delegatorUrl: string): Promise<void> {
    const { delegationId } = start;

    const pending = this.pendingInvitations.get(delegationId);
    if (!pending) {
      console.warn(`[AWCP] Unknown delegation for START: ${delegationId}`);
      return;
    }

    const mountPoint = this.policy.allocateMountPoint(delegationId);
    this.pendingInvitations.delete(delegationId);

    try {
      // Prepare mount point
      await this.policy.prepareMountPoint(mountPoint);

      // Mount the workspace
      await this.sshfsClient.mount({
        endpoint: start.mount.endpoint,
        exportLocator: start.mount.exportLocator,
        credential: start.mount.credential,
        mountPoint,
        options: start.mount.mountOptions,
      });

      // Track active delegation
      this.activeDelegations.set(delegationId, {
        id: delegationId,
        delegatorUrl,
        mountPoint,
        task: pending.invite.task,
        startedAt: new Date(),
      });

      // Call onTaskStart hook
      this.config.hooks.onTaskStart?.(delegationId, mountPoint);

      // Execute task via A2A executor
      const result = await this.executeViaA2A(mountPoint, pending.invite.task);

      // Unmount
      await this.sshfsClient.unmount(mountPoint);

      // Send DONE
      const doneMessage: DoneMessage = {
        version: PROTOCOL_VERSION,
        type: 'DONE',
        delegationId,
        finalSummary: result.summary,
        highlights: result.highlights,
      };

      await this.delegatorClient.send(delegatorUrl, doneMessage);

      // Call onTaskComplete hook
      this.config.hooks.onTaskComplete?.(delegationId, result.summary);

      // Cleanup
      this.activeDelegations.delete(delegationId);
      this.policy.releaseMountPoint(mountPoint);
    } catch (error) {
      // Cleanup on error
      await this.sshfsClient.unmount(mountPoint).catch(() => {});
      this.activeDelegations.delete(delegationId);
      this.policy.releaseMountPoint(mountPoint);

      // Send ERROR
      const errorMessage: ErrorMessage = {
        version: PROTOCOL_VERSION,
        type: 'ERROR',
        delegationId,
        code: ErrorCodes.TASK_FAILED,
        message: error instanceof Error ? error.message : String(error),
        hint: 'Check task requirements and try again',
      };

      await this.delegatorClient.send(delegatorUrl, errorMessage).catch(console.error);

      // Call onError hook
      this.config.hooks.onError?.(
        delegationId,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Handle ERROR message from Delegator
   */
  private async handleError(error: ErrorMessage): Promise<void> {
    const { delegationId } = error;

    // Cleanup if we have an active delegation
    const delegation = this.activeDelegations.get(delegationId);
    if (delegation) {
      await this.sshfsClient.unmount(delegation.mountPoint).catch(() => {});
      this.activeDelegations.delete(delegationId);
      this.policy.releaseMountPoint(delegation.mountPoint);
    }

    // Remove pending invitation if any
    this.pendingInvitations.delete(delegationId);

    // Call onError hook
    this.config.hooks.onError?.(
      delegationId,
      new AwcpError(error.code as any, error.message, error.hint, delegationId)
    );
  }

  /**
   * Execute task via A2A executor
   */
  private async executeViaA2A(
    mountPoint: string,
    task: TaskSpec
  ): Promise<{ summary: string; highlights?: string[] }> {
    // Create synthetic A2A message with task context
    const message: Message = {
      kind: 'message',
      messageId: randomUUID(),
      role: 'user',
      parts: [
        { kind: 'text', text: task.prompt },
        {
          kind: 'text',
          text: `\n\n[AWCP Context]\nWorking directory: ${mountPoint}\nTask: ${task.description}`,
        },
      ],
    };

    // Create request context
    const taskId = randomUUID();
    const contextId = randomUUID();
    const requestContext = new RequestContextImpl(message, taskId, contextId);

    // Create event bus and collect results
    const eventBus = new DefaultExecutionEventBus();
    const results: Message[] = [];

    eventBus.on('event', (event: AgentExecutionEvent) => {
      if (event.kind === 'message') {
        results.push(event);
      }
    });

    // Execute
    await this.executor.execute(requestContext, eventBus);

    // Extract summary from results
    const summary = results
      .flatMap((m) => m.parts)
      .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
      .map((p) => p.text)
      .join('\n');

    return {
      summary: summary || 'Task completed',
    };
  }

  /**
   * Get service status
   */
  getStatus(): ExecutorServiceStatus {
    return {
      pendingInvitations: this.pendingInvitations.size,
      activeDelegations: this.activeDelegations.size,
      delegations: Array.from(this.activeDelegations.values()).map((d) => ({
        id: d.id,
        mountPoint: d.mountPoint,
        startedAt: d.startedAt.toISOString(),
      })),
    };
  }

  /**
   * Create an error message
   */
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

/**
 * Simple RequestContext implementation
 */
class RequestContextImpl {
  readonly userMessage: Message;
  readonly taskId: string;
  readonly contextId: string;
  readonly task?: undefined;
  readonly referenceTasks?: undefined;
  readonly context?: undefined;

  constructor(userMessage: Message, taskId: string, contextId: string) {
    this.userMessage = userMessage;
    this.taskId = taskId;
    this.contextId = contextId;
  }
}
