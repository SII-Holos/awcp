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
import { resolveWorkDir, type TaskStartContext } from '@awcp/sdk';

import { executorAgentCard } from './agent-card.js';
import { FileOperationExecutor } from './executor.js';
import { awcpConfig } from './awcp-config.js';

const executor = new FileOperationExecutor();

const requestHandler = new DefaultRequestHandler(
  executorAgentCard,
  new InMemoryTaskStore(),
  executor
);

const app = express();

app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use('/a2a', jsonRpcHandler({
  requestHandler,
  userBuilder: UserBuilder.noAuthentication
}));

const awcpConfigWithHooks = {
  ...awcpConfig,
  hooks: {
    ...awcpConfig.hooks,
    onTaskStart: (ctx: TaskStartContext) => {
      executor.setWorkingDirectory(resolveWorkDir(ctx));
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

app.use('/awcp', executorHandler({ executor, config: awcpConfigWithHooks }));

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
