/**
 * A2A Agent Server with AWCP Support
 *
 * This example shows how to add AWCP support to an existing A2A agent.
 * The AWCP integration requires only 3 lines of code:
 * 1. Import executorHandler and config
 * 2. app.use('/awcp', executorHandler({ executor, config }))
 */

import express from 'express';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { executorHandler } from '@awcp/sdk/server/express';

import { echoAgentCard } from './agent-card.js';
import { EchoExecutor } from './executor.js';
import { awcpConfig } from './awcp-config.js';

// Create executor (shared between A2A and AWCP)
const executor = new EchoExecutor();

const requestHandler = new DefaultRequestHandler(
  echoAgentCard,
  new InMemoryTaskStore(),
  executor
);

const app = express();

// A2A endpoints
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use('/a2a', jsonRpcHandler({ 
  requestHandler, 
  userBuilder: UserBuilder.noAuthentication 
}));

// AWCP endpoint - Enable workspace delegation support
app.use('/awcp', executorHandler({ executor, config: awcpConfig }));

const PORT = 4001;

app.listen(PORT, () => {
  console.log(`Echo Agent started`);
  console.log(`  Agent Card: http://localhost:${PORT}/${AGENT_CARD_PATH}`);
  console.log(`  JSON-RPC:   http://localhost:${PORT}/a2a`);
  console.log(`  AWCP:       http://localhost:${PORT}/awcp`);
});
