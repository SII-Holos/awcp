/**
 * A2A Agent Server with AWCP Support
 *
 * This example shows how to add AWCP support to an existing A2A agent.
 * The AWCP integration requires only a few lines of code:
 * 1. Import executorHandler, A2ATaskExecutor, and config
 * 2. Wrap your A2A executor with A2ATaskExecutor
 * 3. app.use('/awcp', awcp.router)
 */

import express from 'express';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { executorHandler } from '@awcp/sdk/server/express';
import { A2ATaskExecutor } from '@awcp/sdk';

import { echoAgentCard } from './agent-card.js';
import { EchoExecutor } from './executor.js';
import { awcpConfig } from './awcp-config.js';

// Create A2A executor
const a2aExecutor = new EchoExecutor();

// Wrap with A2ATaskExecutor for AWCP compatibility
const executor = new A2ATaskExecutor(a2aExecutor);

const requestHandler = new DefaultRequestHandler(
  echoAgentCard,
  new InMemoryTaskStore(),
  a2aExecutor
);

const app = express();

// A2A endpoints
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use('/a2a', jsonRpcHandler({ 
  requestHandler, 
  userBuilder: UserBuilder.noAuthentication 
}));

// AWCP endpoint - Enable workspace delegation support
async function main() {
  const awcp = await executorHandler({ executor, config: awcpConfig });
  app.use('/awcp', awcp.router);

  const PORT = 4001;

  app.listen(PORT, () => {
    console.log(`Echo Agent started`);
    console.log(`  Agent Card: http://localhost:${PORT}/${AGENT_CARD_PATH}`);
    console.log(`  JSON-RPC:   http://localhost:${PORT}/a2a`);
    console.log(`  AWCP:       http://localhost:${PORT}/awcp`);
  });
}

main().catch(console.error);
