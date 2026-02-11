/**
 * AWCP Configuration for Executor Agent
 */

import type { ExecutorConfig, TaskStartContext } from '@awcp/sdk';
import type { ExecutorTransportAdapter, InviteMessage } from '@awcp/core';
import { SshfsExecutorTransport } from '@awcp/transport-sshfs';
import { ArchiveExecutorTransport } from '@awcp/transport-archive';
import { StorageExecutorTransport } from '@awcp/transport-storage';

const scenarioDir = process.env.SCENARIO_DIR || process.cwd();

function createTransport(): ExecutorTransportAdapter {
  const type = process.env.AWCP_TRANSPORT || 'sshfs';
  if (type === 'archive') {
    console.log('[AWCP] Using Archive transport');
    return new ArchiveExecutorTransport({ tempDir: `${scenarioDir}/temp` });
  }
  if (type === 'storage') {
    console.log('[AWCP] Using Storage transport');
    return new StorageExecutorTransport({ tempDir: `${scenarioDir}/temp` });
  }
  console.log('[AWCP] Using SSHFS transport');
  return new SshfsExecutorTransport();
}

const VALID_API_KEYS = new Set([
  'sk-test-key-123',
  'sk-demo-key-456',
]);

const REQUIRE_API_KEY = process.env.REQUIRE_API_KEY === 'true';

function validateApiKey(invite: InviteMessage): void {
  if (!REQUIRE_API_KEY) {
    return;
  }

  if (!invite.auth || invite.auth.type !== 'api_key') {
    throw new Error('Missing or invalid auth type');
  }

  if (!VALID_API_KEYS.has(invite.auth.credential)) {
    throw new Error('Invalid API key');
  }

  console.log('[AWCP Auth] Validated successfully');
}

export const awcpConfig: ExecutorConfig = {
  workDir: `${scenarioDir}/workdir`,
  transport: createTransport(),
  admission: {
    maxConcurrentDelegations: 3,
    maxTtlSeconds: 3600,
  },
  assignment: {
    sandbox: {
      cwdOnly: true,
      allowNetwork: false,
      allowExec: false,
    },
  },
  hooks: {
    onAdmissionCheck: async (invite: InviteMessage) => {
      console.log(`[AWCP] Received INVITE: ${invite.delegationId}`);
      console.log(`[AWCP] Required transport: ${invite.requirements?.transport ?? 'any'}`);
      validateApiKey(invite);
      console.log('[AWCP] Accepting invitation');
    },

    onTaskStart: (ctx: TaskStartContext) => {
      console.log(`[AWCP] Task started: ${ctx.delegationId}, path: ${ctx.workPath}`);
    },

    onTaskComplete: (delegationId: string, _summary: string) => {
      console.log(`[AWCP] Task completed: ${delegationId}`);
    },

    onError: (delegationId: string, error: Error) => {
      console.error(`[AWCP] Task error: ${delegationId}`, error.message);
    },
  },
};
