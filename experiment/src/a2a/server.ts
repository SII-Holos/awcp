/**
 * A2A HTTP Server
 * 
 * Simple HTTP server for A2A message exchange.
 * Handles incoming AWCP messages wrapped in A2A format.
 */

import express, { Express, Request, Response } from 'express';
import type { AwcpMessage } from '@awcp/core';
import { 
  A2AMessage, 
  A2AResponse, 
  createSuccessResponse, 
  createErrorResponse 
} from './types.js';

export interface A2AServerConfig {
  /** Server port */
  port: number;
  /** Server name for logging */
  name: string;
  /** Handler for incoming AWCP messages */
  onAwcpMessage: (message: AwcpMessage, senderUrl: string) => Promise<void>;
}

export interface A2AServer {
  /** Express app instance */
  app: Express;
  /** Start the server */
  start: () => Promise<void>;
  /** Stop the server */
  stop: () => Promise<void>;
}

/**
 * Create an A2A HTTP server
 */
export function createA2AServer(config: A2AServerConfig): A2AServer {
  const app = express();
  let server: ReturnType<Express['listen']> | null = null;

  // Middleware
  app.use(express.json());

  // Request logging middleware
  app.use((req, res, next) => {
    if (req.path !== '/health') {
      console.log(`[${config.name}] ${req.method} ${req.path}`);
    }
    next();
  });

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', name: config.name, timestamp: new Date().toISOString() });
  });

  // A2A message endpoint
  app.post('/a2a/message', async (req: Request, res: Response) => {
    try {
      const a2aMessage = req.body as A2AMessage;
      
      if (!a2aMessage || a2aMessage.type !== 'awcp' || !a2aMessage.payload) {
        const response = createErrorResponse(
          a2aMessage?.id || 'unknown',
          'Invalid A2A message format'
        );
        res.status(400).json(response);
        return;
      }

      const awcpMessage = a2aMessage.payload;
      const senderUrl = a2aMessage.senderUrl;

      console.log(`[${config.name}] ← Received ${awcpMessage.type} from ${senderUrl}`);

      // Process the AWCP message
      await config.onAwcpMessage(awcpMessage, senderUrl);

      const response: A2AResponse = createSuccessResponse(a2aMessage.id);
      res.json(response);
    } catch (error) {
      console.error(`[${config.name}] Error processing message:`, error);
      const response = createErrorResponse(
        'unknown',
        error instanceof Error ? error.message : 'Unknown error'
      );
      res.status(500).json(response);
    }
  });

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  return {
    app,
    start: () => new Promise((resolve) => {
      server = app.listen(config.port, () => {
        console.log(`[${config.name}] A2A Server listening on port ${config.port}`);
        resolve();
      });
    }),
    stop: () => new Promise((resolve, reject) => {
      if (server) {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        resolve();
      }
    }),
  };
}
