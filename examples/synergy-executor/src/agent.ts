/**
 * Synergy Executor Agent
 * 
 * A2A Agent with AWCP support for executing coding tasks
 * using Synergy AI coding agent on delegated workspaces.
 */

import express from 'express';
import { join } from 'node:path';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { executorHandler } from '@awcp/sdk/server/express';

import { synergyAgentCard } from './agent-card.js';
import { SynergyExecutor } from './synergy-executor.js';
import { awcpConfig } from './awcp-config.js';
import { loadConfig } from './config.js';
import type { TaskStartContext } from '@awcp/sdk';

const config = loadConfig();

const executor = new SynergyExecutor(config.synergyUrl);

const requestHandler = new DefaultRequestHandler(
  synergyAgentCard,
  new InMemoryTaskStore(),
  executor
);

const app = express();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }) as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use('/a2a', jsonRpcHandler({
  requestHandler,
  userBuilder: UserBuilder.noAuthentication
}) as any);

function resolveWorkDir(ctx: TaskStartContext): string {
  const { environment, workPath } = ctx;
  const rwResource = environment.resources.find((r) => r.mode === 'rw');
  if (rwResource) {
    return join(workPath, rwResource.name);
  }
  if (environment.resources.length === 1) {
    return join(workPath, environment.resources[0]!.name);
  }
  return workPath;
}

const awcpConfigWithHooks = {
  ...awcpConfig,
  hooks: {
    ...awcpConfig.hooks,
    onTaskStart: (ctx: TaskStartContext) => {
      const workDir = resolveWorkDir(ctx);
      executor.setWorkingDirectory(workDir, {
        leaseExpiresAt: new Date(ctx.lease.expiresAt),
        delegationId: ctx.delegationId,
      });
      awcpConfig.hooks?.onTaskStart?.(ctx);
    },
    onTaskComplete: (delegationId: string, summary: string) => {
      executor.clearWorkingDirectory();
      awcpConfig.hooks?.onTaskComplete?.(delegationId, summary);
    },
    onError: (delegationId: string, error: Error) => {
      executor.clearWorkingDirectory();
      awcpConfig.hooks?.onError?.(delegationId, error);
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use('/awcp', executorHandler({ executor, config: awcpConfigWithHooks }) as any);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', synergy: config.synergyUrl });
});

app.listen(config.port, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         Synergy Executor Agent Started                     ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Agent Card:  http://localhost:${config.port}/${AGENT_CARD_PATH.padEnd(26)}║`);
  console.log(`║  A2A:         http://localhost:${config.port}/a2a${' '.repeat(24)}║`);
  console.log(`║  AWCP:        http://localhost:${config.port}/awcp${' '.repeat(23)}║`);
  console.log(`║  Synergy:     ${config.synergyUrl.padEnd(43)}║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
});

