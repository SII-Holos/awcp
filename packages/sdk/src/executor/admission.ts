import type { InviteMessage, ExecutorTransportAdapter, Assignment } from '@awcp/core';
import { AwcpError, ErrorCodes } from '@awcp/core';
import type { ResolvedExecutorConfig } from './config.js';

export interface AdmissionCheckContext {
  invite: InviteMessage;
  assignments: Map<string, Assignment>;
  transport: ExecutorTransportAdapter;
}

export class AdmissionController {
  private config: ResolvedExecutorConfig['admission'];

  constructor(config: ResolvedExecutorConfig['admission']) {
    this.config = config;
  }

  async check(context: AdmissionCheckContext): Promise<void> {
    const { invite, assignments, transport } = context;
    const { delegationId } = invite;

    const activeCount = Array.from(assignments.values())
      .filter(a => a.state === 'active').length;
    if (activeCount >= this.config.maxConcurrentDelegations) {
      throw new AwcpError(
        ErrorCodes.DECLINED,
        'Maximum concurrent delegations reached',
        'Try again later when current tasks complete',
        delegationId,
      );
    }

    if (invite.lease.ttlSeconds > this.config.maxTtlSeconds) {
      throw new AwcpError(
        ErrorCodes.DECLINED,
        `Requested TTL (${invite.lease.ttlSeconds}s) exceeds maximum (${this.config.maxTtlSeconds}s)`,
        `Request a shorter TTL (max: ${this.config.maxTtlSeconds}s)`,
        delegationId,
      );
    }

    if (!this.config.allowedAccessModes.includes(invite.lease.accessMode)) {
      throw new AwcpError(
        ErrorCodes.DECLINED,
        `Access mode '${invite.lease.accessMode}' not allowed`,
        `Allowed modes: ${this.config.allowedAccessModes.join(', ')}`,
        delegationId,
      );
    }

    const depCheck = await transport.checkDependency();
    if (!depCheck.available) {
      throw new AwcpError(
        ErrorCodes.DEP_MISSING,
        `Transport ${transport.type} is not available`,
        depCheck.hint,
        delegationId,
      );
    }
  }
}
