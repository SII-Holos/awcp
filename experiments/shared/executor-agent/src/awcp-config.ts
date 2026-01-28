/**
 * AWCP Configuration for Executor Agent
 */

import type { ExecutorConfig } from '@awcp/sdk';

// Get mount root from environment or use default
const scenarioDir = process.env.SCENARIO_DIR || process.cwd();

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
    autoAccept: true,  // Automatically accept delegations
  },
  hooks: {
    onTaskStart: (delegationId: string, mountPoint: string) => {
      console.log(`[AWCP] Task started: ${delegationId}`);
      console.log(`[AWCP] Workspace mounted at: ${mountPoint}`);
    },
    onTaskComplete: (delegationId: string, summary: string) => {
      console.log(`[AWCP] Task completed: ${delegationId}`);
      console.log(`[AWCP] Summary: ${summary}`);
    },
    onError: (delegationId: string, error: Error) => {
      console.error(`[AWCP] Task error: ${delegationId}`, error.message);
    },
  },
};
