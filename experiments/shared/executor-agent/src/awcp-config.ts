/**
 * AWCP Configuration for Executor Agent
 */

import type { ExecutorConfig } from '@awcp/sdk';
import type { InviteMessage } from '@awcp/core';

const scenarioDir = process.env.SCENARIO_DIR || process.cwd();

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
  mount: {
    root: `${scenarioDir}/mounts`,
  },
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
      
      const isValid = await validateApiKey(invite);
      if (!isValid) {
        return false;
      }

      console.log(`[AWCP] Accepting invitation`);
      return true;
    },
    
    onTaskStart: (delegationId: string, mountPoint: string) => {
      console.log(`[AWCP] Task started: ${delegationId}, mount: ${mountPoint}`);
    },
    
    onTaskComplete: (delegationId: string, _summary: string) => {
      console.log(`[AWCP] Task completed: ${delegationId}`);
    },
    
    onError: (delegationId: string, error: Error) => {
      console.error(`[AWCP] Task error: ${delegationId}`, error.message);
    },
  },
};
