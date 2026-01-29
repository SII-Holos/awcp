/**
 * Delegator Daemon Process
 *
 * Runs the Delegator as an independent daemon process that can be accessed
 * by multiple clients (MCP, CLI, HTTP API, etc.)
 *
 * Usage:
 *   npx delegator-daemon --port 3100 --config delegator.json
 *
 * Or programmatically:
 *   import { startDelegatorDaemon } from '@awcp/sdk/delegator/bin/daemon';
 *   await startDelegatorDaemon({ port: 3100, config: myConfig });
 */

import { createServer } from 'node:http';
import express, { json } from 'express';
import { DelegatorService, type DelegatorServiceOptions } from '../service.js';
import type { DelegatorConfig } from '../config.js';
import { AwcpError } from '@awcp/core';

/**
 * Daemon configuration
 */
export interface DaemonConfig {
  /** Port to listen on (default: 3100) */
  port?: number;
  /** Host to bind to (default: 'localhost') */
  host?: string;
  /** Delegator configuration */
  delegator: DelegatorConfig;
}

/**
 * Running daemon instance
 */
export interface DaemonInstance {
  /** Stop the daemon */
  stop: () => Promise<void>;
  /** Get the service instance */
  service: DelegatorService;
  /** Get the base URL */
  url: string;
}

/**
 * Start the Delegator Daemon
 *
 * This starts an HTTP server that provides:
 * - POST /delegate - Create a new delegation
 * - GET /delegations - List all delegations
 * - GET /delegation/:id - Get delegation status
 * - DELETE /delegation/:id - Cancel a delegation
 * - POST /callback - Receive messages from Executor
 *
 * @example
 * ```typescript
 * const daemon = await startDelegatorDaemon({
 *   port: 3100,
 *   delegator: {
 *     export: { baseDir: '/tmp/awcp/exports' },
 *     ssh: { host: 'localhost', user: 'awcp' },
 *   },
 * });
 *
 * // Create delegation via HTTP
 * const response = await fetch('http://localhost:3100/delegate', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({
 *     executorUrl: 'http://executor:4001/awcp',
 *     localDir: '/path/to/project',
 *     task: { description: 'Fix bug', prompt: '...' },
 *   }),
 * });
 *
 * // Stop daemon
 * await daemon.stop();
 * ```
 */
export async function startDelegatorDaemon(config: DaemonConfig): Promise<DaemonInstance> {
  const port = config.port ?? 3100;
  const host = config.host ?? 'localhost';
  const baseUrl = `http://${host}:${port}`;

  const app = express();
  app.use(json());

  // Create service with callback URL pointing to this daemon
  const serviceOptions: DelegatorServiceOptions = {
    config: config.delegator,
    callbackUrl: `${baseUrl}/callback`,
  };
  const service = new DelegatorService(serviceOptions);

  // ============================================
  // API Routes
  // ============================================

  /**
   * POST /delegate - Create a new delegation
   *
   * Body:
   * {
   *   executorUrl: string,
   *   localDir: string,
   *   task: { description: string, prompt: string },
   *   ttlSeconds?: number,
   *   accessMode?: 'ro' | 'rw'
   * }
   *
   * Response:
   * { delegationId: string }
   */
  app.post('/delegate', async (req, res) => {
    try {
      const { executorUrl, localDir, task, ttlSeconds, accessMode } = req.body;

      if (!executorUrl || !localDir || !task) {
        res.status(400).json({
          error: 'Missing required fields: executorUrl, localDir, task',
        });
        return;
      }

      const delegationId = await service.delegate({
        executorUrl,
        localDir,
        task,
        ttlSeconds,
        accessMode,
      });

      res.json({ delegationId });
    } catch (error) {
      console.error('[Delegator Daemon] Error creating delegation:', error);
      
      if (error instanceof AwcpError) {
        res.status(400).json({
          error: error.message,
          code: error.code,
          hint: error.hint,
        });
      } else {
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Failed to create delegation',
        });
      }
    }
  });

  /**
   * GET /delegations - List all delegations
   */
  app.get('/delegations', (_req, res) => {
    res.json(service.getStatus());
  });

  /**
   * GET /delegation/:id - Get delegation status
   */
  app.get('/delegation/:id', (req, res) => {
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
  app.delete('/delegation/:id', async (req, res) => {
    try {
      await service.cancel(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Failed to cancel',
      });
    }
  });

  /**
   * POST /callback - Receive messages from Executor
   *
   * This endpoint receives ACCEPT, DONE, and ERROR messages from Executors.
   */
  app.post('/callback', async (req, res) => {
    try {
      await service.handleMessage(req.body);
      res.json({ ok: true });
    } catch (error) {
      console.error('[Delegator Daemon] Error handling callback:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  });

  /**
   * GET /health - Health check
   */
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Start server
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => {
      console.log(`[Delegator Daemon] Listening on ${baseUrl}`);
      resolve();
    });
    server.on('error', reject);
  });

  return {
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log('[Delegator Daemon] Stopped');
    },
    service,
    url: baseUrl,
  };
}

/**
 * CLI entry point
 */
export async function main(): Promise<void> {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let port = 3100;
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1]!, 10);
      i++;
    } else if (args[i] === '--config' && args[i + 1]) {
      configPath = args[i + 1];
      i++;
    }
  }

  if (!configPath) {
    console.error('Usage: delegator-daemon --port 3100 --config <config.json>');
    console.error('');
    console.error('Config file should contain:');
    console.error(JSON.stringify({
      export: { baseDir: '/tmp/awcp/exports' },
      ssh: { host: 'localhost', user: 'awcp' },
    }, null, 2));
    process.exit(1);
  }

  // Load config
  const fs = await import('node:fs/promises');
  const configContent = await fs.readFile(configPath, 'utf-8');
  const delegatorConfig = JSON.parse(configContent) as DelegatorConfig;

  // Start daemon
  const daemon = await startDelegatorDaemon({
    port,
    delegator: delegatorConfig,
  });

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Delegator Daemon] Shutting down...');
    await daemon.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await daemon.stop();
    process.exit(0);
  });

  console.log(`[Delegator Daemon] Ready. API available at ${daemon.url}`);
}
