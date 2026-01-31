/**
 * Start Executor Agent for 04-archive-transport scenario
 * 
 * Uses ArchiveTransport - downloads workspace as ZIP, works locally, uploads changes.
 */

import { createServer } from 'node:http';
import express, { json } from 'express';
import { ExecutorService } from '@awcp/sdk';
import { ArchiveTransport } from '@awcp/transport-archive';
import type { AwcpMessage } from '@awcp/core';
import { resolve } from 'node:path';

const SCENARIO_DIR = process.env.SCENARIO_DIR || process.cwd();
const PORT = parseInt(process.env.EXECUTOR_PORT || '4001', 10);

// Simple mock executor that modifies files
const mockExecutor = {
  async execute(context: any, eventBus: any) {
    const workDir = context.userMessage.parts
      .find((p: any) => p.text?.includes('Working directory:'))
      ?.text?.match(/Working directory: (.+)/)?.[1];

    if (workDir) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      
      // Read and modify hello.txt
      const helloPath = path.join(workDir, 'hello.txt');
      try {
        const content = await fs.readFile(helloPath, 'utf-8');
        const newContent = content + `\nModified via Archive Transport at ${new Date().toISOString()}`;
        await fs.writeFile(helloPath, newContent);
        
        eventBus.emit('event', {
          kind: 'message',
          role: 'assistant',
          parts: [{ kind: 'text', text: `Modified hello.txt successfully` }],
        });
      } catch (err) {
        eventBus.emit('event', {
          kind: 'message',
          role: 'assistant',
          parts: [{ kind: 'text', text: `Error: ${err}` }],
        });
      }
    }
  },
};

async function main() {
  const workDir = resolve(SCENARIO_DIR, 'mounts');
  const tempDir = resolve(SCENARIO_DIR, 'temp');

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Starting AWCP Executor (Archive Transport)             ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Port:        ${PORT}`);
  console.log(`  Work Dir:    ${workDir}`);
  console.log(`  Temp Dir:    ${tempDir}`);
  console.log(`  Transport:   archive (HTTP-based)`);
  console.log('');

  const executorService = new ExecutorService({
    executor: mockExecutor as any,
    config: {
      workDir,
      transport: new ArchiveTransport({
        executor: {
          tempDir,
        },
      }),
      policy: {
        maxConcurrentDelegations: 3,
        maxTtlSeconds: 3600,
        autoAccept: true,
      },
      hooks: {
        onTaskStart: (ctx) => console.log(`[Executor] Task started: ${ctx.delegationId} at ${ctx.workPath}`),
        onTaskComplete: (id) => console.log(`[Executor] Task completed: ${id}`),
        onError: (id, err) => console.error(`[Executor] Error: ${id}`, err.message),
      },
    },
  });

  const app = express();
  app.use(json());

  // AWCP endpoint
  app.post('/awcp', async (req, res) => {
    const message = req.body as AwcpMessage;

    console.log(`[Executor] Received ${message.type}: ${message.delegationId}`);

    try {
      const response = await executorService.handleMessage(message);
      if (response) {
        res.json(response);
      } else {
        res.json({ ok: true });
      }
    } catch (error) {
      console.error('[Executor] Error:', error);
      res.status(500).json({ error: String(error) });
    }
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', transport: 'archive' });
  });

  const server = createServer(app);
  server.listen(PORT, () => {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         Executor Agent Ready                               ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  AWCP:        http://localhost:${PORT}/awcp`.padEnd(61) + '║');
    console.log(`║  Health:      http://localhost:${PORT}/health`.padEnd(61) + '║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down Executor...');
    server.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start Executor:', err);
  process.exit(1);
});
