/**
 * OpenClaw Executor Agent
 */

import express from 'express';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { executorHandler } from '@awcp/sdk/server/express';
import { A2ATaskExecutor } from '@awcp/sdk';

import { loadAppConfig } from './app-config.js';
import { loadOpenClawConfig } from './openclaw-config.js';
import { createAgentCard } from './agent-card.js';
import { OpenClawExecutor } from './openclaw-executor.js';
import { OpenClawGatewayManager } from './gateway-manager.js';
import { createAwcpConfig } from './awcp-config.js';

async function main() {
  const appConfig = loadAppConfig();
  const openclawConfig = loadOpenClawConfig(appConfig);

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         OpenClaw Executor Agent - Starting...              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Data directory: ${appConfig.dataDir}`);

  const gatewayManager = new OpenClawGatewayManager(appConfig, openclawConfig);
  await gatewayManager.start();

  const a2aExecutor = new OpenClawExecutor(gatewayManager);
  const executor = new A2ATaskExecutor(a2aExecutor);
  const agentCard = createAgentCard(appConfig);

  const requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), a2aExecutor);

  const app = express();

  // Increase body size limit for large workspace transfers
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  app.use(
    `/${AGENT_CARD_PATH}`,
    agentCardHandler({ agentCardProvider: requestHandler }) as unknown as express.RequestHandler,
  );
  app.use(
    '/a2a',
    jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }) as unknown as express.RequestHandler,
  );

  const awcpConfig = createAwcpConfig(appConfig, a2aExecutor, gatewayManager);
  const awcp = await executorHandler({ executor, config: awcpConfig });
  app.use('/awcp', awcp.router);

  app.get('/health', async (_req, res) => {
    const gatewayHealthy = await gatewayManager.checkHealth();
    res.json({
      status: gatewayHealthy ? 'ok' : 'degraded',
      gateway: { url: openclawConfig.gatewayUrl, healthy: gatewayHealthy, pid: gatewayManager.pid },
      listeners: awcp.getListenerInfos(),
    });
  });

  const gracefulShutdown = async (signal: string) => {
    console.log(`\n[Agent] Received ${signal}, shutting down...`);
    await awcp.stop();
    await gatewayManager.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  app.listen(appConfig.port, appConfig.host, () => {
    const displayHost = appConfig.host === '0.0.0.0' ? 'localhost' : appConfig.host;
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║         OpenClaw Executor Agent Ready!                         ║');
    console.log('╠════════════════════════════════════════════════════════════════╣');
    console.log(`║  Local:       http://${displayHost}:${appConfig.port}/awcp`);

    for (const info of awcp.getListenerInfos()) {
      if (info.type !== 'http') {
        console.log(`║  Tunnel:      ${info.publicUrl}`);
      }
    }

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
