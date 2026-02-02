/**
 * AWCP Configuration for Echo Agent
 */

import type { ExecutorConfig, TaskStartContext } from '@awcp/sdk';
import { SshfsTransport } from '@awcp/transport-sshfs';

export const awcpConfig: ExecutorConfig = {
  workDir: '/tmp/awcp/mounts',
  transport: new SshfsTransport(),
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
    onTaskStart: (ctx: TaskStartContext) => {
      console.log(`[AWCP] Task started: ${ctx.delegationId} at ${ctx.workPath}`);
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
