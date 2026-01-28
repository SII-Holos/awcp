/**
 * AWCP Delegator Express Handler
 *
 * Express middleware for enabling AWCP Delegator functionality.
 * This handler receives ACCEPT/DONE/ERROR messages from Executor.
 */

import { Router, json } from 'express';
import type { DelegatorConfig } from '../../delegator/config.js';
import { DelegatorService } from '../../delegator/service.js';

/**
 * Options for the AWCP Delegator Express handler
 */
export interface DelegatorHandlerOptions {
  /**
   * AWCP Delegator configuration
   */
  config: DelegatorConfig;

  /**
   * Callback URL where this handler is mounted
   *
   * This URL is sent to Executor in the X-AWCP-Callback-URL header
   * so Executor knows where to send ACCEPT/DONE/ERROR messages.
   *
   * Example: 'http://localhost:3000/awcp'
   */
  callbackUrl: string;
}

/**
 * Result of creating the handler
 */
export interface DelegatorHandlerResult {
  /** Express router to mount */
  router: Router;
  /** Service instance for creating delegations */
  service: DelegatorService;
}

/**
 * Create an Express router that handles AWCP Delegator messages
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { delegatorHandler } from '@awcp/sdk/server/express';
 *
 * const app = express();
 *
 * const { router, service } = delegatorHandler({
 *   config: {
 *     export: { baseDir: '/tmp/awcp/exports' },
 *     ssh: { host: 'localhost', user: 'myuser' },
 *   },
 *   callbackUrl: 'http://localhost:3000/awcp',
 * });
 *
 * // Mount the router
 * app.use('/awcp', router);
 *
 * // Use the service to create delegations
 * const delegationId = await service.delegate({
 *   executorUrl: 'http://executor-agent:4001/awcp',
 *   localDir: '/path/to/project',
 *   task: { description: 'Fix bug', prompt: '...' },
 * });
 * ```
 */
export function delegatorHandler(options: DelegatorHandlerOptions): DelegatorHandlerResult {
  const router = Router();
  const service = new DelegatorService({
    config: options.config,
    callbackUrl: options.callbackUrl,
  });

  // Parse JSON bodies
  router.use(json());

  /**
   * POST / - Receive AWCP messages from Executor
   *
   * Executor sends ACCEPT, DONE, and ERROR messages to this endpoint.
   */
  router.post('/', async (req, res) => {
    try {
      const message = req.body;

      await service.handleMessage(message);

      res.json({ ok: true });
    } catch (error) {
      console.error('[AWCP Delegator] Error handling message:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  });

  /**
   * GET /status - Get service status
   *
   * Returns information about active delegations.
   */
  router.get('/status', (_req, res) => {
    res.json(service.getStatus());
  });

  /**
   * GET /delegation/:id - Get delegation details
   */
  router.get('/delegation/:id', (req, res) => {
    const delegation = service.getDelegation(req.params.id);
    if (!delegation) {
      res.status(404).json({ error: 'Delegation not found' });
      return;
    }
    res.json(delegation);
  });

  /**
   * DELETE /delegation/:id - Cancel a delegation
   */
  router.delete('/delegation/:id', async (req, res) => {
    try {
      await service.cancel(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Failed to cancel',
      });
    }
  });

  return { router, service };
}
