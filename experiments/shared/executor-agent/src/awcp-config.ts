/**
 * AWCP Configuration for Executor Agent
 * 
 * Supports both SSHFS and Archive transports via AWCP_TRANSPORT env var.
 */

import type { ExecutorConfig, TaskStartContext } from '@awcp/sdk';
import type { InviteMessage, TransportAdapter } from '@awcp/core';
import { SshfsTransport } from '@awcp/transport-sshfs';
import { ArchiveTransport } from '@awcp/transport-archive';

const scenarioDir = process.env.SCENARIO_DIR || process.cwd();

// Transport selection: 'sshfs' (default) or 'archive'
const transportType = process.env.AWCP_TRANSPORT || 'sshfs';

function createTransport(): TransportAdapter {
  switch (transportType) {
    case 'archive':
      console.log('[AWCP Config] Using Archive transport (HTTP-based)');
      return new ArchiveTransport({
        executor: {
          tempDir: `${scenarioDir}/temp`,
        },
      });

    case 'sshfs':
    default:
      console.log('[AWCP Config] Using SSHFS transport');
      return new SshfsTransport();
  }
}

// Valid API keys (in production, use database/billing service)
const VALID_API_KEYS = new Set([
  'sk-test-key-123',
  'sk-demo-key-456',
]);

const REQUIRE_API_KEY = process.env.REQUIRE_API_KEY === 'true';

async function validateApiKey(invite: InviteMessage): Promise<boolean> {
  if (!REQUIRE_API_KEY) {
    return true;
  }

  if (!invite.auth || invite.auth.type !== 'api_key') {
    console.log(`[AWCP Auth] Missing or invalid auth type`);
    return false;
  }

  if (!VALID_API_KEYS.has(invite.auth.credential)) {
    console.log(`[AWCP Auth] Invalid API key`);
    return false;
  }

  console.log(`[AWCP Auth] Validated successfully`);
  return true;
}

export const awcpConfig: ExecutorConfig = {
  workDir: `${scenarioDir}/workdir`,
  transport: createTransport(),
  sandbox: {
    cwdOnly: true,
    allowNetwork: false,
    allowExec: false,
  },
  policy: {
    maxConcurrentDelegations: 3,
    maxTtlSeconds: 3600,
    autoAccept: false,
  },
  hooks: {
    onInvite: async (invite: InviteMessage) => {
      console.log(`[AWCP] Received INVITE: ${invite.delegationId}`);
      console.log(`[AWCP] Required transport: ${invite.requirements?.transport || 'any'}`);
      
      const isValid = await validateApiKey(invite);
      if (!isValid) {
        return false;
      }

      console.log(`[AWCP] Accepting invitation`);
      return true;
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
