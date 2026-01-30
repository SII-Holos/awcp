import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ArchiveServer } from '../src/delegator/archive-server.js';
import { ArchiveCreator } from '../src/delegator/archive-creator.js';

describe('ArchiveServer', () => {
  let tempDir: string;
  let server: ArchiveServer;
  let creator: ArchiveCreator;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'awcp-test-'));
    server = new ArchiveServer({ tempDir });
    creator = new ArchiveCreator({ tempDir });
  });

  afterEach(async () => {
    await server.stop();
    await creator.cleanupAll();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('should start and stop the server', async () => {
    expect(server.isRunning).toBe(false);

    await server.start();
    expect(server.isRunning).toBe(true);
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    await server.stop();
    expect(server.isRunning).toBe(false);
  });

  it('should serve archive downloads', async () => {
    await server.start();

    // Create test archive
    const sourceDir = path.join(tempDir, 'source');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'test.txt'), 'hello world');

    const result = await creator.create('test-delegation', sourceDir);
    server.register('test-delegation', result.archivePath, sourceDir);

    // Download the archive
    const downloadUrl = server.downloadUrl('test-delegation');
    const response = await fetch(downloadUrl);

    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toBe('application/zip');

    const buffer = await response.arrayBuffer();
    expect(buffer.byteLength).toBe(result.sizeBytes);
  });

  it('should accept archive uploads', async () => {
    await server.start();

    // Create and register a delegation
    const sourceDir = path.join(tempDir, 'source');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'test.txt'), 'original');

    const result = await creator.create('test-delegation', sourceDir);
    server.register('test-delegation', result.archivePath, sourceDir);

    // Upload a new archive
    const uploadUrl = server.uploadUrl('test-delegation');
    const uploadData = await fs.promises.readFile(result.archivePath);

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: uploadData,
    });

    expect(response.ok).toBe(true);
    const json = await response.json();
    expect(json).toEqual({ ok: true });

    // Verify upload was tracked
    const uploadedPath = server.getUploadedArchive('test-delegation');
    expect(uploadedPath).toBeDefined();
  });

  it('should return 404 for unknown delegations', async () => {
    await server.start();

    const response = await fetch(server.downloadUrl('unknown'));
    expect(response.status).toBe(404);
  });
});
