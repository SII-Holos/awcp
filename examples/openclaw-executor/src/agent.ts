/**
 * OpenClaw Executor Agent
 *
 * A2A Agent with AWCP support for executing coding tasks
 * using OpenClaw AI assistant on delegated workspaces.
 *
 * This example demonstrates how to integrate an AI assistant with AWCP:
 * 1. Load application and AI-specific configuration
 * 2. Create AWCP executor configuration with lifecycle hooks
 * 3. Start the HTTP server with A2A and AWCP endpoints
 */

import express from 'express';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { executorHandler } from '@awcp/sdk/server/express';

import { loadAppConfig } from './app-config.js';
import { loadOpenClawConfig } from './openclaw-config.js';
import { createAgentCard } from './agent-card.js';
import { OpenClawExecutor } from './openclaw-executor.js';
import { OpenClawGatewayManager } from './gateway-manager.js';
import { createAwcpConfig } from './awcp-config.js';

async function main() {
  // --- Step 1: Load Configuration ---
  const appConfig = loadAppConfig();
  const openclawConfig = loadOpenClawConfig(appConfig);

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         OpenClaw Executor Agent - Starting...              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Data directory: ${appConfig.dataDir}`);

  // --- Step 2: Start OpenClaw Gateway ---
  const gatewayManager = new OpenClawGatewayManager(appConfig, openclawConfig);
  await gatewayManager.start();

  // --- Step 3: Create Executor ---
  const executor = new OpenClawExecutor(gatewayManager);

  // --- Step 4: Create A2A Agent Card ---
  const agentCard = createAgentCard(appConfig);

  const requestHandler = new DefaultRequestHandler(
    agentCard,
    new InMemoryTaskStore(),
    executor
  );

  // --- Step 5: Setup Express Server ---
  const app = express();

  // A2A endpoints
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }) as unknown as express.RequestHandler);
  app.use('/a2a', jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication
  }) as unknown as express.RequestHandler);

  // --- Step 6: Create AWCP Configuration ---
  // This is the standard AWCP configuration - same pattern for any AI assistant
  const awcpConfig = createAwcpConfig(appConfig, executor, gatewayManager);

  // AWCP endpoint
  app.use('/awcp', executorHandler({ executor, config: awcpConfig }) as unknown as express.RequestHandler);

  // Health check endpoint
  app.get('/health', async (_req, res) => {
    const gatewayHealthy = await gatewayManager.checkHealth();
    res.json({
      status: gatewayHealthy ? 'ok' : 'degraded',
      gateway: {
        url: openclawConfig.gatewayUrl,
        healthy: gatewayHealthy,
        pid: gatewayManager.pid,
      },
    });
  });

  // --- Step 7: Graceful Shutdown ---
  const gracefulShutdown = async (signal: string) => {
    console.log(`\n[Agent] Received ${signal}, shutting down...`);
    await gatewayManager.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // --- Step 8: Start Server ---
  app.listen(appConfig.port, appConfig.host, () => {
    const displayHost = appConfig.host === '0.0.0.0' ? 'localhost' : appConfig.host;
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║         OpenClaw Executor Agent Ready!                         ║');
    console.log('╠════════════════════════════════════════════════════════════════╣');
    console.log(`║  Agent Card:  http://${displayHost}:${appConfig.port}/.well-known/agent-card.json`);
    console.log(`║  A2A:         http://${displayHost}:${appConfig.port}/a2a`);
    console.log(`║  AWCP:        http://${displayHost}:${appConfig.port}/awcp`);
    console.log(`║  OpenClaw:    ${openclawConfig.gatewayUrl}`);
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Press Ctrl+C to stop...');
  });
}

main().catch((error) => {
  console.error('Failed to start OpenClaw Executor:', error);
  process.exit(1);
});
