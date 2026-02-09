/**
 * AWCP Configuration for Vision Executor
 *
 * Uses SSHFS transport by default for real-time file access,
 * allowing the delegator to observe changes as they happen.
 */

import type { ExecutorConfig, TaskStartContext } from '@awcp/sdk';
import type { InviteMessage, TransportAdapter } from '@awcp/core';
import { SshfsTransport } from '@awcp/transport-sshfs';
import { ArchiveTransport } from '@awcp/transport-archive';
import { loadConfig } from './config.js';

const config = loadConfig();

// Transport selection: 'sshfs' (default for vision tasks) or 'archive'
const transportType = process.env.AWCP_TRANSPORT || 'sshfs';

function createTransport(): TransportAdapter {
  switch (transportType) {
    case 'archive':
      console.log('[AWCP] Using Archive transport (HTTP-based)');
      return new ArchiveTransport({
        executor: {
          tempDir: `${config.scenarioDir}/temp`,
        },
      });

    case 'sshfs':
    default:
      console.log('[AWCP] Using SSHFS transport (real-time file access)');
      return new SshfsTransport();
  }
}

export const awcpConfig: ExecutorConfig = {
  workDir: `${config.scenarioDir}/workdir`,
  transport: createTransport(),
  sandbox: {
    cwdOnly: true,
    allowNetwork: true,
    allowExec: true,
  },
  policy: {
    maxConcurrentDelegations: 3,
    maxTtlSeconds: 7200,
    autoAccept: false,
  },
  hooks: {
    onInvite: async (invite: InviteMessage) => {
      console.log(`[AWCP] Received INVITE: ${invite.delegationId}`);
      console.log(`[AWCP] Task: ${invite.task.description}`);
      console.log(`[AWCP] Accepting invitation`);
      return true;
    },

    onTaskStart: (ctx: TaskStartContext) => {
      console.log(`[AWCP] Task started: ${ctx.delegationId}`);
      console.log(`[AWCP] Workspace: ${ctx.workPath}`);
      console.log(`[AWCP] Lease expires: ${ctx.lease.expiresAt}`);
    },

    onTaskComplete: (delegationId: string, summary: string) => {
      console.log(`[AWCP] Task completed: ${delegationId}`);
      console.log(`[AWCP] Summary: ${summary.slice(0, 200)}...`);
    },

    onError: (delegationId: string, error: Error) => {
      console.error(`[AWCP] Task error: ${delegationId}`, error.message);
    },
  },
};
