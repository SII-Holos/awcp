/**
 * Local Storage Server
 *
 * Simulates S3-like pre-signed URL functionality for testing the Storage Transport.
 * Serves files from the local storage directory and accepts uploads.
 */

import express from 'express';
import { createServer } from 'node:http';
import { resolve, dirname, join } from 'node:path';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const SCENARIO_DIR = process.env.SCENARIO_DIR || process.cwd();
const STORAGE_PORT = parseInt(process.env.STORAGE_PORT || '3200', 10);
const STORAGE_DIR = resolve(SCENARIO_DIR, 'storage');

async function main() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });

  const app = express();

  // Serve files (GET - download)
  app.get('/workspaces/:filename', async (req, res) => {
    const filename = req.params.filename;
    const filePath = join(STORAGE_DIR, 'workspaces', filename);

    console.log(`[Storage] GET /workspaces/${filename}`);

    try {
      await fs.access(filePath);
      res.setHeader('Content-Type', 'application/zip');
      createReadStream(filePath).pipe(res);
    } catch {
      console.log(`[Storage] File not found: ${filePath}`);
      res.status(404).json({ error: 'File not found' });
    }
  });

  // Upload files (PUT - upload)
  app.put('/workspaces/:filename', async (req, res) => {
    const filename = req.params.filename;
    const filePath = join(STORAGE_DIR, 'workspaces', filename);

    console.log(`[Storage] PUT /workspaces/${filename}`);

    try {
      await fs.mkdir(dirname(filePath), { recursive: true });

      const writeStream = createWriteStream(filePath);
      await pipeline(req, writeStream);

      console.log(`[Storage] Uploaded: ${filePath}`);
      res.json({ ok: true, path: filePath });
    } catch (error) {
      console.error(`[Storage] Upload error:`, error);
      res.status(500).json({ error: String(error) });
    }
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', storageDir: STORAGE_DIR });
  });

  // List files (for debugging)
  app.get('/files', async (_req, res) => {
    try {
      const workspacesDir = join(STORAGE_DIR, 'workspaces');
      await fs.mkdir(workspacesDir, { recursive: true });
      const files = await fs.readdir(workspacesDir);
      res.json({ files });
    } catch {
      res.json({ files: [] });
    }
  });

  const server = createServer(app);
  server.listen(STORAGE_PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         Local Storage Server Started                       ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  Port:        ${STORAGE_PORT}                                         ║`);
    console.log(`║  Storage Dir: ${STORAGE_DIR.slice(0, 43).padEnd(43)}║`);
    console.log(`║  Download:    GET  /workspaces/:filename                   ║`);
    console.log(`║  Upload:      PUT  /workspaces/:filename                   ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
  });

  process.on('SIGINT', () => {
    console.log('\n[Storage] Shutting down...');
    server.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start storage server:', err);
  process.exit(1);
});
