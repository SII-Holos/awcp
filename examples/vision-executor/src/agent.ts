/**
 * Vision Executor Agent
 *
 * A2A Agent with AWCP support for executing visual understanding
 * and file organization tasks using Synergy AI agent with vision models.
 */

import express from 'express';
import { createWriteStream } from 'node:fs';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { executorHandler } from '@awcp/sdk/server/express';
import { resolveWorkDir, A2ATaskExecutor, type TaskStartContext } from '@awcp/sdk';

import { visionAgentCard } from './agent-card.js';
import { SynergyExecutor } from './synergy-executor.js';
import { startSynergyServer } from './synergy-server.js';
import { awcpConfig } from './awcp-config.js';
import { loadConfig } from './config.js';

function setupLogFile(logFile: string): void {
  const stream = createWriteStream(logFile, { flags: 'a' });
  const timestamp = () => new Date().toISOString();
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => {
    stream.write(`[${timestamp()}] ${args.join(' ')}\n`);
    originalLog.apply(console, args);
  };
  console.error = (...args) => {
    stream.write(`[${timestamp()}] ${args.join(' ')}\n`);
    originalError.apply(console, args);
  };
  console.log(`[VisionExecutor] Logging to ${logFile}`);
}

async function main() {
  const config = loadConfig();

  if (config.logFile) {
    setupLogFile(config.logFile);
  }

  let synergyUrl = config.synergyUrl;
  let closeSynergy: (() => void) | undefined;

  if (config.synergyAutoStart) {
    const port = new URL(synergyUrl).port || '2026';
    const server = await startSynergyServer({ port: parseInt(port, 10) });
    synergyUrl = server.url;
    closeSynergy = server.close;
  }

  const a2aExecutor = new SynergyExecutor(synergyUrl);
  const executor = new A2ATaskExecutor(a2aExecutor);

  const requestHandler = new DefaultRequestHandler(
    visionAgentCard,
    new InMemoryTaskStore(),
    a2aExecutor
  );

  const app = express();

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

  const awcp = await executorHandler({ executor, config: awcpConfigWithHooks });
  app.use('/awcp', awcp.router as unknown as express.RequestHandler);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', synergy: synergyUrl });
  });

  const shutdown = () => {
    closeSynergy?.();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  app.listen(config.port, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         Vision Executor Agent Started                      ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  Agent Card:  http://localhost:${config.port}/${AGENT_CARD_PATH.padEnd(26)}║`);
    console.log(`║  A2A:         http://localhost:${config.port}/a2a${' '.repeat(24)}║`);
    console.log(`║  AWCP:        http://localhost:${config.port}/awcp${' '.repeat(23)}║`);
    console.log(`║  Synergy:     ${synergyUrl.padEnd(43)}║`);
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
  });
}

main().catch(console.error);
