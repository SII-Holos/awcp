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
  executor: AgentExecutor;
  config: ExecutorConfig;
}

/**
 * Create an Express router that handles AWCP messages (Executor side)
 */
export function executorHandler(options: ExecutorHandlerOptions): Router {
  const router = Router();
  const service = new ExecutorService({
    executor: options.executor,
    config: options.config,
  });

  router.use(json());

  /**
   * POST / - Receive AWCP messages from Delegator
   */
  router.post('/', async (req, res) => {
    try {
      const message = req.body;

      // START: wait for delegation setup, then respond (task runs async)
      if (message.type === 'START') {
        await service.handleMessage(message);
        res.json({ ok: true });
        return;
      }

      const response = await service.handleMessage(message);
      if (response) {
        res.json(response);
      } else {
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
   * GET /tasks/:taskId/events - SSE endpoint for task events
   */
  router.get('/tasks/:taskId/events', (req, res) => {
    const { taskId } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const unsubscribe = service.subscribeTask(taskId, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);

      if (event.type === 'done' || event.type === 'error') {
        res.end();
      }
    });

    req.on('close', () => {
      unsubscribe();
    });
  });

  /**
   * GET /status - Get service status
   */
  router.get('/status', (_req, res) => {
    res.json(service.getStatus());
  });

  /**
   * POST /cancel/:delegationId - Cancel a delegation
   */
  router.post('/cancel/:delegationId', async (req, res) => {
    try {
      const { delegationId } = req.params;
      await service.cancelDelegation(delegationId);
      res.json({ ok: true, cancelled: true });
    } catch (error) {
      console.error('[AWCP Executor] Error cancelling delegation:', error);
      res.status(error instanceof Error && error.message.includes('not found') ? 404 : 500).json({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  });

  return router;
}
