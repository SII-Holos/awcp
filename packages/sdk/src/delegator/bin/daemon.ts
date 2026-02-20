/**
 * Delegator Daemon Process
 *
 * Runs the Delegator as an independent daemon process that can be accessed
 * by multiple clients (MCP, CLI, HTTP API, etc.)
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
  port?: number;
  host?: string;
  delegator: DelegatorConfig;
}

/**
 * Running daemon instance
 */
export interface DaemonInstance {
  shutdown: () => Promise<void>;
  service: DelegatorService;
  url: string;
}

/**
 * Start the Delegator Daemon
 */
export async function startDelegatorDaemon(config: DaemonConfig): Promise<DaemonInstance> {
  const port = config.port ?? 3100;
  const host = config.host ?? 'localhost';
  const baseUrl = `http://${host}:${port}`;

  const app = express();
  app.use(json());

  const serviceOptions: DelegatorServiceOptions = {
    config: config.delegator,
  };
  const service = new DelegatorService(serviceOptions);
  await service.initialize();

  /**
   * POST /delegate - Create a new delegation
   */
  app.post('/delegate', async (req, res) => {
    try {
      const { executorUrl, environment, task, ttlSeconds, accessMode } = req.body;

      if (!executorUrl || !environment || !task) {
        res.status(400).json({
          error: 'Missing required fields: executorUrl, environment, task',
        });
        return;
      }

      const delegationId = await service.delegate({
        executorUrl,
        environment,
        task,
        ttlSeconds,
        accessMode,
      });

      res.json({ delegationId });
    } catch (error) {
      console.error('[AWCP:Daemon] Error creating delegation:', error);
      
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
      const known = Array.from((service as any).delegations?.keys?.() ?? []);
      console.warn(
        `[AWCP:Daemon] GET /delegation/${req.params.id} not found` +
        ` (known=${known.length} delegations: [${known.join(',')}])`
      );
      res.status(404).json({
        error: `Delegation not found in daemon: no delegation with id ${req.params.id}`,
        hint: 'The daemon may have been restarted, losing in-memory state',
        knownDelegations: known.length,
      });
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
   * GET /delegation/:id/snapshots - List snapshots for a delegation
   */
  app.get('/delegation/:id/snapshots', (req, res) => {
    try {
      const snapshots = service.listSnapshots(req.params.id);
      res.json({ snapshots });
    } catch (error) {
      res.status(404).json({
        error: error instanceof Error ? error.message : 'Failed to list snapshots',
      });
    }
  });

  /**
   * POST /delegation/:id/snapshots/:snapshotId/apply - Apply a snapshot
   */
  app.post('/delegation/:id/snapshots/:snapshotId/apply', async (req, res) => {
    try {
      await service.applySnapshot(req.params.id, req.params.snapshotId);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Failed to apply snapshot',
      });
    }
  });

  /**
   * POST /delegation/:id/snapshots/:snapshotId/discard - Discard a snapshot
   */
  app.post('/delegation/:id/snapshots/:snapshotId/discard', async (req, res) => {
    try {
      await service.discardSnapshot(req.params.id, req.params.snapshotId);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Failed to discard snapshot',
      });
    }
  });

  /**
   * GET /health - Health check
   */
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => {
      console.log(`[AWCP:Daemon] Listening on ${baseUrl}`);
      resolve();
    });
    server.on('error', reject);
  });

  return {
    shutdown: async () => {
      await service.shutdown();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log('[AWCP:Daemon] Stopped');
    },
    service,
    url: baseUrl,
  };
}

/**
 * CLI entry point
 */
export async function main(): Promise<void> {
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
    console.error('Usage: delegator-daemon --port 3100 --config <config.ts>');
    process.exit(1);
  }

  const fs = await import('node:fs/promises');
  const configContent = await fs.readFile(configPath, 'utf-8');
  const delegatorConfig = JSON.parse(configContent) as DelegatorConfig;

  const daemon = await startDelegatorDaemon({
    port,
    delegator: delegatorConfig,
  });

  process.on('SIGINT', async () => {
    console.log('\n[AWCP:Daemon] Shutting down...');
    await daemon.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await daemon.shutdown();
    process.exit(0);
  });

  console.log(`[AWCP:Daemon] Ready. API available at ${daemon.url}`);
}
