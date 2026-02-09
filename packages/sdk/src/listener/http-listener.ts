/**
 * HTTP Listener - Express Router for direct HTTP access
 */

import { Router, json } from 'express';
import type {
  ExecutorRequestHandler,
  ListenerAdapter,
  ListenerInfo,
  ListenerCallbacks,
  TaskEvent,
} from '@awcp/core';

export interface HttpListenerConfig {
  publicUrl?: string;
}

export class HttpListener implements ListenerAdapter {
  readonly type = 'http';

  private router: Router | null = null;
  private config: HttpListenerConfig;

  constructor(config?: HttpListenerConfig) {
    this.config = config ?? {};
  }

  async start(handler: ExecutorRequestHandler, callbacks?: ListenerCallbacks): Promise<ListenerInfo | null> {
    this.router = Router();
    this.router.use(json({ limit: '50mb' }));

    this.router.post('/', async (req, res) => {
      try {
        const message = req.body;
        if (message.type === 'START') {
          await handler.handleMessage(message);
          res.json({ ok: true });
          return;
        }
        const response = await handler.handleMessage(message);
        res.json(response ?? { ok: true });
      } catch (error) {
        console.error('[AWCP:HttpListener] Error:', error);
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Internal error',
        });
      }
    });

    this.router.get('/tasks/:taskId/events', (req, res) => {
      const { taskId } = req.params;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const unsubscribe = handler.subscribeTask(taskId, (event: TaskEvent) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'done' || event.type === 'error') {
          res.end();
        }
      });

      req.on('close', () => unsubscribe());
    });

    this.router.get('/tasks/:taskId/result', (req, res) => {
      const { taskId } = req.params;
      const result = handler.getTaskResult(taskId);
      const status = result.status === 'not_found' ? 404 : 200;
      res.status(status).json(result);
    });

    this.router.post('/tasks/:taskId/ack', (req, res) => {
      handler.acknowledgeResult(req.params.taskId);
      res.json({ ok: true });
    });

    this.router.get('/status', (_req, res) => {
      res.json(handler.getStatus());
    });

    this.router.post('/cancel/:delegationId', async (req, res) => {
      try {
        await handler.cancelDelegation(req.params.delegationId);
        res.json({ ok: true, cancelled: true });
      } catch (error) {
        const status = error instanceof Error && error.message.includes('not found') ? 404 : 500;
        res.status(status).json({
          error: error instanceof Error ? error.message : 'Internal error',
        });
      }
    });

    // ========== Chunked Transfer Endpoints ==========

    // 接收单个分块
    this.router.post('/chunks/:delegationId', async (req, res) => {
      try {
        const { delegationId } = req.params;
        const { index, data, checksum } = req.body;

        if (typeof index !== 'number' || typeof data !== 'string' || typeof checksum !== 'string') {
          res.status(400).json({ error: 'Invalid chunk data' });
          return;
        }

        await handler.receiveChunk(delegationId, index, data, checksum);
        res.json({ ok: true, received: index });
      } catch (error) {
        console.error('[AWCP:HttpListener] Chunk receive error:', error);
        res.status(400).json({
          error: error instanceof Error ? error.message : 'Chunk receive failed',
        });
      }
    });

    // 查询分块状态（用于断点续传）
    this.router.get('/chunks/:delegationId/status', (req, res) => {
      try {
        const { delegationId } = req.params;
        const status = handler.getChunkStatus(delegationId);

        if (!status.exists) {
          res.status(404).json({ error: 'Chunk receiver not found' });
          return;
        }

        res.json({
          received: status.received,
          missing: status.missing,
          complete: status.complete,
        });
      } catch (error) {
        console.error('[AWCP:HttpListener] Chunk status error:', error);
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Internal error',
        });
      }
    });

    // 完成分块传输
    this.router.post('/chunks/:delegationId/complete', async (req, res) => {
      try {
        const { delegationId } = req.params;
        const { totalChecksum } = req.body;

        if (typeof totalChecksum !== 'string') {
          res.status(400).json({ error: 'Missing totalChecksum' });
          return;
        }

        await handler.completeChunks(delegationId, totalChecksum);
        res.json({ ok: true, assembled: true });
      } catch (error) {
        console.error('[AWCP:HttpListener] Chunk complete error:', error);
        res.status(400).json({
          error: error instanceof Error ? error.message : 'Chunk assembly failed',
        });
      }
    });

    if (this.config.publicUrl) {
      const info: ListenerInfo = { type: this.type, publicUrl: this.config.publicUrl };
      callbacks?.onConnected?.(info);
      return info;
    }

    return null;
  }

  getRouter(): Router {
    if (!this.router) {
      throw new Error('HttpListener not started');
    }
    return this.router;
  }

  async stop(): Promise<void> {
    this.router = null;
  }
}
