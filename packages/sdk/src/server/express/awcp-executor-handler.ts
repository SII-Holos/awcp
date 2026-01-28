/**
 * AWCP Executor Express Handler
 *
 * Express middleware for enabling AWCP support in an A2A agent (Executor side).
 */

import { Router, json } from 'express';
import type { AgentExecutor } from '@a2a-js/sdk/server';
import type { ExecutorConfig } from '../../executor/config.js';
import { ExecutorService } from '../../executor/service.js';

/**
 * Options for the AWCP Executor Express handler
 */
export interface ExecutorHandlerOptions {
  /**
   * A2A agent executor
   *
   * This is the executor that will be called to execute tasks.
   * It should be the same executor used by the A2A agent.
   */
  executor: AgentExecutor;

  /**
   * AWCP Executor configuration
   */
  config: ExecutorConfig;
}

/**
 * Create an Express router that handles AWCP messages (Executor side)
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { executorHandler } from '@awcp/sdk/server/express';
 *
 * const app = express();
 *
 * // ... existing A2A setup ...
 *
 * // Enable AWCP
 * app.use('/awcp', executorHandler({
 *   executor: myExecutor,
 *   config: {
 *     mount: { root: '/tmp/awcp/mounts' },
 *   },
 * }));
 * ```
 */
export function executorHandler(options: ExecutorHandlerOptions): Router {
  const router = Router();
  const service = new ExecutorService({
    executor: options.executor,
    config: options.config,
  });

  // Parse JSON bodies
  router.use(json());

  /**
   * POST / - Receive AWCP messages from Delegator
   *
   * The Delegator sends INVITE and START messages to this endpoint.
   * The Delegator URL for sending responses is provided in the
   * X-AWCP-Callback-URL header.
   */
  router.post('/', async (req, res) => {
    try {
      const message = req.body;
      const delegatorUrl = req.headers['x-awcp-callback-url'] as string | undefined;

      if (!delegatorUrl && message.type !== 'ERROR') {
        res.status(400).json({
          error: 'Missing X-AWCP-Callback-URL header',
        });
        return;
      }

      const response = await service.handleMessage(message, delegatorUrl ?? '');

      if (response) {
        // INVITE returns ACCEPT/ERROR synchronously
        res.json(response);
      } else {
        // START is handled async, just acknowledge
        res.json({ ok: true });
      }
    } catch (error) {
      console.error('[AWCP Executor] Error handling message:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  });

  /**
   * GET /status - Get service status
   *
   * Returns information about pending and active delegations.
   */
  router.get('/status', (_req, res) => {
    res.json(service.getStatus());
  });

  return router;
}
