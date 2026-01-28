/**
 * AWCP Configuration for Echo Agent
 */

import type { ExecutorConfig } from '@awcp/sdk';

export const awcpConfig: ExecutorConfig = {
  mount: {
    root: '/tmp/awcp/mounts',
  },
  sandbox: {
    cwdOnly: true,
    allowNetwork: true,
    allowExec: true,
  },
  policy: {
    maxConcurrentDelegations: 3,
    maxTtlSeconds: 3600,
    autoAccept: true,
  },
  hooks: {
    onTaskStart: (delegationId: string, mountPoint: string) => {
      console.log(`[AWCP] Task started: ${delegationId} at ${mountPoint}`);
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
