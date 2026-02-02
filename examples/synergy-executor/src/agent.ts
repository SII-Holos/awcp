/**
 * Synergy Executor Agent
 * 
 * A2A Agent with AWCP support for executing coding tasks
 * using Synergy AI coding agent on delegated workspaces.
 */

import express from 'express';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { executorHandler } from '@awcp/sdk/server/express';
import { resolveWorkDir, type TaskStartContext } from '@awcp/sdk';

import { synergyAgentCard } from './agent-card.js';
import { SynergyExecutor } from './synergy-executor.js';
import { awcpConfig } from './awcp-config.js';
import { loadConfig } from './config.js';

const config = loadConfig();

const executor = new SynergyExecutor(config.synergyUrl);

const requestHandler = new DefaultRequestHandler(
  synergyAgentCard,
  new InMemoryTaskStore(),
  executor
);

const app = express();

// Type casts needed due to @types/express version mismatch between packages
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }) as unknown as express.RequestHandler);
app.use('/a2a', jsonRpcHandler({
  requestHandler,
  userBuilder: UserBuilder.noAuthentication
}) as unknown as express.RequestHandler);

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

app.use('/awcp', executorHandler({ executor, config: awcpConfigWithHooks }) as unknown as express.RequestHandler);

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

