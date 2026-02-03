/**
 * AWCP Executor Agent
 */

import express from 'express';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { executorHandler } from '@awcp/sdk/server/express';
import { resolveWorkDir, A2ATaskExecutor, type TaskStartContext } from '@awcp/sdk';

import { executorAgentCard } from './agent-card.js';
import { FileOperationExecutor } from './executor.js';
import { awcpConfig } from './awcp-config.js';

const a2aExecutor = new FileOperationExecutor();
const executor = new A2ATaskExecutor(a2aExecutor);

const requestHandler = new DefaultRequestHandler(executorAgentCard, new InMemoryTaskStore(), a2aExecutor);

const app = express();

app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use(
  '/a2a',
  jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
  }),
);

const awcpConfigWithHooks = {
  ...awcpConfig,
  hooks: {
    ...awcpConfig.hooks,
    onTaskStart: (ctx: TaskStartContext) => {
      a2aExecutor.setWorkingDirectory(resolveWorkDir(ctx));
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
  app.use('/awcp', awcp.router);

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
}

main().catch(console.error);
