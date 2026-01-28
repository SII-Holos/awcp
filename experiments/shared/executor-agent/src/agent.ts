/**
 * AWCP Executor Agent
 * 
 * A2A Agent with AWCP support for executing file operations
 * on delegated workspaces.
 */

import express from 'express';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { executorHandler } from '@awcp/sdk/server/express';

import { executorAgentCard } from './agent-card.js';
import { FileOperationExecutor } from './executor.js';
import { awcpConfig } from './awcp-config.js';

// Create executor instance (shared between A2A and AWCP)
const executor = new FileOperationExecutor();

// A2A Request Handler
const requestHandler = new DefaultRequestHandler(
  executorAgentCard,
  new InMemoryTaskStore(),
  executor
);

// Create Express app
const app = express();

// A2A endpoints
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use('/a2a', jsonRpcHandler({ 
  requestHandler, 
  userBuilder: UserBuilder.noAuthentication 
}));

// AWCP endpoint with hooks to control executor's working directory
const awcpConfigWithHooks = {
  ...awcpConfig,
  hooks: {
    ...awcpConfig.hooks,
    onTaskStart: (delegationId: string, mountPoint: string) => {
      // Set the executor's working directory to the mounted workspace
      executor.setWorkingDirectory(mountPoint);
      awcpConfig.hooks?.onTaskStart?.(delegationId, mountPoint);
    },
    onTaskComplete: (delegationId: string, summary: string) => {
      // Clear the working directory after task completes
      executor.clearWorkingDirectory();
      awcpConfig.hooks?.onTaskComplete?.(delegationId, summary);
    },
    onError: (delegationId: string, error: Error) => {
      executor.clearWorkingDirectory();
      awcpConfig.hooks?.onError?.(delegationId, error);
    },
  },
};

app.use('/awcp', executorHandler({ executor, config: awcpConfigWithHooks }));

// Start server
const PORT = parseInt(process.env.PORT || '4001', 10);

app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         AWCP Executor Agent Started                        ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Agent Card:  http://localhost:${PORT}/${AGENT_CARD_PATH.padEnd(26)}║`);
  console.log(`║  A2A:         http://localhost:${PORT}/a2a${' '.repeat(24)}║`);
  console.log(`║  AWCP:        http://localhost:${PORT}/awcp${' '.repeat(23)}║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
});
