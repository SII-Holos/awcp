/**
 * Archive Server
 *
 * HTTP server for serving archive downloads and receiving uploads.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pipeline } from 'node:stream/promises';
import type { ArchiveDelegatorConfig } from '../types.js';

interface RegisteredArchive {
  archivePath: string;
  exportDir: string;
}

export class ArchiveServer {
  private server?: http.Server;
  private archives = new Map<string, RegisteredArchive>();
  private uploads = new Map<string, string>();
  private _baseUrl?: string;
  private tempDir: string;

  constructor(private config: ArchiveDelegatorConfig = {}) {
    this.tempDir = config.tempDir ?? path.join(os.tmpdir(), 'awcp-archives');
  }

  get baseUrl(): string {
    if (!this._baseUrl) throw new Error('ArchiveServer not started');
    return this._baseUrl;
  }

  get isRunning(): boolean {
    return !!this.server;
  }

  async start(): Promise<void> {
    if (this.server) return;

    const port = this.config.serverPort ?? 0;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error('[ArchiveServer] Request error:', err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(port, '127.0.0.1', () => {
        const addr = this.server!.address() as { port: number };
        this._baseUrl = this.config.publicBaseUrl ?? `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this.server = undefined;
    this._baseUrl = undefined;
  }

  /**
   * Register an archive for download
   */
  register(delegationId: string, archivePath: string, exportDir: string): void {
    this.archives.set(delegationId, { archivePath, exportDir });
  }

  /**
   * Unregister an archive
   */
  unregister(delegationId: string): void {
    this.archives.delete(delegationId);
    this.uploads.delete(delegationId);
  }

  /**
   * Get the path to an uploaded archive (if any)
   */
  getUploadedArchive(delegationId: string): string | undefined {
    return this.uploads.get(delegationId);
  }

  /**
   * Get the export directory for a delegation
   */
  getExportDir(delegationId: string): string | undefined {
    return this.archives.get(delegationId)?.exportDir;
  }

  /**
   * Generate download URL for a delegation
   */
  downloadUrl(delegationId: string): string {
    return `${this.baseUrl}/archive/${delegationId}/download`;
  }

  /**
   * Generate upload URL for a delegation
   */
  uploadUrl(delegationId: string): string {
    return `${this.baseUrl}/archive/${delegationId}/upload`;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this._baseUrl);
    const match = url.pathname.match(/^\/archive\/([^/]+)\/(download|upload)$/);

    if (!match) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    const [, delegationId, action] = match;

    if (action === 'download' && req.method === 'GET') {
      await this.handleDownload(delegationId!, res);
    } else if (action === 'upload' && req.method === 'POST') {
      await this.handleUpload(delegationId!, req, res);
    } else {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    }
  }

  private async handleDownload(delegationId: string, res: http.ServerResponse): Promise<void> {
    const registered = this.archives.get(delegationId);
    if (!registered) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Archive not found', delegationId }));
      return;
    }

    try {
      const stats = await fs.promises.stat(registered.archivePath);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': stats.size,
        'Content-Disposition': `attachment; filename="${delegationId}.zip"`,
      });

      await pipeline(fs.createReadStream(registered.archivePath), res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to read archive' }));
      }
    }
  }

  private async handleUpload(
    delegationId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.archives.has(delegationId)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Unknown delegation', delegationId }));
      return;
    }

    try {
      await fs.promises.mkdir(this.tempDir, { recursive: true });
      const uploadPath = path.join(this.tempDir, `${delegationId}-upload.zip`);

      await pipeline(req, fs.createWriteStream(uploadPath));

      this.uploads.set(delegationId, uploadPath);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to save upload' }));
    }
  }
}
