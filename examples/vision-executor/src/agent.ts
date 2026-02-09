/**
 * Vision Executor Agent
 *
 * A2A Agent with AWCP support for executing visual understanding
 * and file organization tasks using Synergy AI agent with vision models.
 */

import express from 'express';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { executorHandler } from '@awcp/sdk/server/express';
import { resolveWorkDir, A2ATaskExecutor, type TaskStartContext } from '@awcp/sdk';

import { visionAgentCard } from './agent-card.js';
import { SynergyExecutor } from './synergy-executor.js';
import { awcpConfig } from './awcp-config.js';
import { loadConfig } from './config.js';

const config = loadConfig();

const a2aExecutor = new SynergyExecutor(config.synergyUrl);
const executor = new A2ATaskExecutor(a2aExecutor);

const requestHandler = new DefaultRequestHandler(
  visionAgentCard,
  new InMemoryTaskStore(),
  a2aExecutor
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
      a2aExecutor.setWorkingDirectory(workDir, {
        leaseExpiresAt: new Date(ctx.lease.expiresAt),
        delegationId: ctx.delegationId,
      });
      awcpConfig.hooks?.onTaskStart?.(ctx);
    },
    onTaskComplete: (delegationId: string, summary: string) => {
      a2aExecutor.clearWorkingDirectory();
      awcpConfig.hooks?.onTaskComplete?.(delegationId, summary);
    },
    onError: (delegationId: string, error: Error) => {
      a2aExecutor.clearWorkingDirectory();
      awcpConfig.hooks?.onError?.(delegationId, error);
    },
  },
};

async function main() {
  const awcp = await executorHandler({ executor, config: awcpConfigWithHooks });
  app.use('/awcp', awcp.router as unknown as express.RequestHandler);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', synergy: config.synergyUrl });
  });

  app.listen(config.port, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         Vision Executor Agent Started                      ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  Agent Card:  http://localhost:${config.port}/${AGENT_CARD_PATH.padEnd(26)}║`);
    console.log(`║  A2A:         http://localhost:${config.port}/a2a${' '.repeat(24)}║`);
    console.log(`║  AWCP:        http://localhost:${config.port}/awcp${' '.repeat(23)}║`);
    console.log(`║  Synergy:     ${config.synergyUrl.padEnd(43)}║`);
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
  });
}

main().catch(console.error);
