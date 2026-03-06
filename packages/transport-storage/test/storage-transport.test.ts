import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { StorageDelegatorTransport } from '../src/delegator/transport.js';
import { StorageExecutorTransport } from '../src/executor/transport.js';
import { LocalStorageProvider } from '../src/delegator/local-storage.js';
import type { StorageTransportHandle } from '@awcp/core';
import { extractArchive } from '@awcp/transport-archive';

describe('StorageDelegatorTransport', () => {
  let tempDir: string;
  let storageDir: string;
  let server: http.Server;
  let serverPort: number;
  let transport: StorageDelegatorTransport;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'awcp-storage-test-'));
    storageDir = path.join(tempDir, 'storage');
    await fs.promises.mkdir(storageDir, { recursive: true });

    server = http.createServer(async (req, res) => {
      const filePath = path.join(storageDir, req.url!);

      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', async () => {
          try {
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            await fs.promises.writeFile(filePath, Buffer.concat(chunks));
            res.writeHead(200);
            res.end('OK');
          } catch {
            res.writeHead(500);
            res.end('Upload failed');
          }
        });
        return;
      }

      try {
        const data = await fs.promises.readFile(filePath);
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        serverPort = (server.address() as { port: number }).port;
        resolve();
      });
    });

    transport = new StorageDelegatorTransport({
      tempDir,
      provider: {
        type: 'local',
        localDir: storageDir,
        endpoint: `http://localhost:${serverPort}`,
      },
    });
    await transport.initialize();
  });

  afterEach(async () => {
    await transport.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('should prepare and return StorageTransportHandle', async () => {
    const exportDir = path.join(tempDir, 'export');
    await fs.promises.mkdir(exportDir, { recursive: true });
    await fs.promises.writeFile(path.join(exportDir, 'test.txt'), 'hello world');

    const handle = await transport.prepare({
      delegationId: 'test-delegation',
      exportPath: exportDir,
      ttlSeconds: 300,
    });

    expect(handle.transport).toBe('storage');
    const storageHandle = handle as StorageTransportHandle;
    expect(storageHandle.downloadUrl).toContain('http://localhost');
    expect(storageHandle.uploadUrl).toContain('http://localhost');
    expect(storageHandle.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(storageHandle.expiresAt).toBeDefined();
  });

  it('should clean up temp ZIP after prepare', async () => {
    const exportDir = path.join(tempDir, 'export');
    await fs.promises.mkdir(exportDir, { recursive: true });
    await fs.promises.writeFile(path.join(exportDir, 'test.txt'), 'hello');

    await transport.prepare({
      delegationId: 'test-delegation',
      exportPath: exportDir,
      ttlSeconds: 300,
    });

    const files = await fs.promises.readdir(tempDir);
    const zips = files.filter(f => f.endsWith('.zip'));
    expect(zips).toHaveLength(0);
  });

  it('should release storage objects via provider', async () => {
    const exportDir = path.join(tempDir, 'export');
    await fs.promises.mkdir(exportDir, { recursive: true });
    await fs.promises.writeFile(path.join(exportDir, 'test.txt'), 'hello');

    await transport.prepare({
      delegationId: 'test-delegation',
      exportPath: exportDir,
      ttlSeconds: 300,
    });

    const storagePath = path.join(storageDir, 'workspaces', 'test-delegation.zip');
    const existsBefore = await fs.promises.access(storagePath).then(() => true).catch(() => false);
    expect(existsBefore).toBe(true);

    await transport.release('test-delegation');

    const existsAfter = await fs.promises.access(storagePath).then(() => true).catch(() => false);
    expect(existsAfter).toBe(false);
  });
});

describe('StorageExecutorTransport', () => {
  let tempDir: string;
  let storageDir: string;
  let server: http.Server;
  let serverPort: number;
  let delegator: StorageDelegatorTransport;
  let executor: StorageExecutorTransport;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'awcp-storage-test-'));
    storageDir = path.join(tempDir, 'storage');
    await fs.promises.mkdir(storageDir, { recursive: true });

    server = http.createServer(async (req, res) => {
      const filePath = path.join(storageDir, req.url!);

      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', async () => {
          try {
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            await fs.promises.writeFile(filePath, Buffer.concat(chunks));
            res.writeHead(200);
            res.end('OK');
          } catch {
            res.writeHead(500);
            res.end('Upload failed');
          }
        });
        return;
      }

      try {
        const data = await fs.promises.readFile(filePath);
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        serverPort = (server.address() as { port: number }).port;
        resolve();
      });
    });

    const delegatorTempDir = path.join(tempDir, 'delegator-temp');
    delegator = new StorageDelegatorTransport({
      tempDir: delegatorTempDir,
      provider: {
        type: 'local',
        localDir: storageDir,
        endpoint: `http://localhost:${serverPort}`,
      },
    });
    await delegator.initialize();

    const executorTempDir = path.join(tempDir, 'executor-temp');
    executor = new StorageExecutorTransport({ tempDir: executorTempDir });
    await executor.initialize();
  });

  afterEach(async () => {
    await executor.shutdown();
    await delegator.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('should report dependencies as available', async () => {
    const result = await executor.checkDependency();
    expect(result.available).toBe(true);
  });

  it('should setup a workspace from handle', async () => {
    const exportDir = path.join(tempDir, 'export');
    await fs.promises.mkdir(exportDir, { recursive: true });
    await fs.promises.writeFile(path.join(exportDir, 'test.txt'), 'hello world');
    await fs.promises.mkdir(path.join(exportDir, 'subdir'));
    await fs.promises.writeFile(path.join(exportDir, 'subdir', 'nested.txt'), 'nested');

    const handle = await delegator.prepare({
      delegationId: 'test-delegation',
      exportPath: exportDir,
      ttlSeconds: 300,
    });

    const localPath = path.join(tempDir, 'work');
    const resultPath = await executor.setup({
      delegationId: 'test-delegation',
      handle,
      localPath,
    });

    expect(resultPath).toBe(localPath);
    expect(await fs.promises.readFile(path.join(localPath, 'test.txt'), 'utf-8')).toBe('hello world');
    expect(await fs.promises.readFile(path.join(localPath, 'subdir', 'nested.txt'), 'utf-8')).toBe('nested');
  });

  it('should capture snapshot and upload to storage', async () => {
    const exportDir = path.join(tempDir, 'export');
    await fs.promises.mkdir(exportDir, { recursive: true });
    await fs.promises.writeFile(path.join(exportDir, 'original.txt'), 'original content');

    const handle = await delegator.prepare({
      delegationId: 'test-delegation',
      exportPath: exportDir,
      ttlSeconds: 300,
    });

    const localPath = path.join(tempDir, 'work');
    await executor.setup({ delegationId: 'test-delegation', handle, localPath });

    await fs.promises.writeFile(path.join(localPath, 'original.txt'), 'modified content');
    await fs.promises.writeFile(path.join(localPath, 'new-file.txt'), 'new file content');

    const result = await executor.captureSnapshot({
      delegationId: 'test-delegation',
      localPath,
    });

    expect(result.snapshotBase64).toBeDefined();
    const snapshotInfo = JSON.parse(result.snapshotBase64);
    expect(snapshotInfo.resultUrl).toContain('http://localhost');

    const response = await fetch(snapshotInfo.resultUrl);
    expect(response.ok).toBe(true);
    const buffer = Buffer.from(await response.arrayBuffer());
    const resultZip = path.join(tempDir, 'verify-result.zip');
    await fs.promises.writeFile(resultZip, buffer);
    const resultDir = path.join(tempDir, 'verify-result');
    await extractArchive(resultZip, resultDir);

    expect(await fs.promises.readFile(path.join(resultDir, 'original.txt'), 'utf-8')).toBe('modified content');
    expect(await fs.promises.readFile(path.join(resultDir, 'new-file.txt'), 'utf-8')).toBe('new file content');
  });

  it('should preserve stored handle after detach (multi-round support)', async () => {
    const exportDir = path.join(tempDir, 'export');
    await fs.promises.mkdir(exportDir, { recursive: true });
    await fs.promises.writeFile(path.join(exportDir, 'test.txt'), 'hello');

    const handle = await delegator.prepare({
      delegationId: 'test-delegation',
      exportPath: exportDir,
      ttlSeconds: 300,
    });

    const localPath = path.join(tempDir, 'work');
    await executor.setup({ delegationId: 'test-delegation', handle, localPath });
    await executor.detach({ delegationId: 'test-delegation', localPath });

    const result = await executor.captureSnapshot({
      delegationId: 'test-delegation',
      localPath,
    });

    const snapshotInfo = JSON.parse(result.snapshotBase64);
    expect(snapshotInfo.resultUrl).toContain('http://localhost');
  });

  it('should clean stored handle on release (final cleanup)', async () => {
    const exportDir = path.join(tempDir, 'export');
    await fs.promises.mkdir(exportDir, { recursive: true });
    await fs.promises.writeFile(path.join(exportDir, 'test.txt'), 'hello');

    const handle = await delegator.prepare({
      delegationId: 'test-delegation',
      exportPath: exportDir,
      ttlSeconds: 300,
    });

    const localPath = path.join(tempDir, 'work');
    await executor.setup({ delegationId: 'test-delegation', handle, localPath });
    await executor.release({ delegationId: 'test-delegation', localPath });

    const result = await executor.captureSnapshot({
      delegationId: 'test-delegation',
      localPath,
    });

    const snapshotData = result.snapshotBase64;
    expect(() => JSON.parse(snapshotData)).toThrow();
  });

  describe('Multi-round scenarios', () => {
    it('should support multiple snapshot captures across rounds without re-setup', async () => {
      const exportDir = path.join(tempDir, 'export');
      await fs.promises.mkdir(exportDir, { recursive: true });
      await fs.promises.writeFile(path.join(exportDir, 'data.txt'), 'initial');

      const handle = await delegator.prepare({
        delegationId: 'test-delegation',
        exportPath: exportDir,
        ttlSeconds: 300,
      });

      const localPath = path.join(tempDir, 'work');
      await executor.setup({ delegationId: 'test-delegation', handle, localPath });

      await fs.promises.writeFile(path.join(localPath, 'data.txt'), 'round 1');
      const result1 = await executor.captureSnapshot({
        delegationId: 'test-delegation',
        localPath,
      });
      const snapshot1 = JSON.parse(result1.snapshotBase64);
      expect(snapshot1.resultUrl).toContain('http://localhost');

      await executor.detach({ delegationId: 'test-delegation', localPath });

      await fs.promises.writeFile(path.join(localPath, 'data.txt'), 'round 2');
      const result2 = await executor.captureSnapshot({
        delegationId: 'test-delegation',
        localPath,
      });
      const snapshot2 = JSON.parse(result2.snapshotBase64);
      expect(snapshot2.resultUrl).toContain('http://localhost');
    });

    it('should upload to correct URL across multiple rounds', async () => {
      const exportDir = path.join(tempDir, 'export');
      await fs.promises.mkdir(exportDir, { recursive: true });
      await fs.promises.writeFile(path.join(exportDir, 'file.txt'), 'original');

      const handle = await delegator.prepare({
        delegationId: 'test-delegation',
        exportPath: exportDir,
        ttlSeconds: 300,
      });

      const localPath = path.join(tempDir, 'work');
      await executor.setup({ delegationId: 'test-delegation', handle, localPath });

      await fs.promises.writeFile(path.join(localPath, 'file.txt'), 'round 1 content');
      const result1 = await executor.captureSnapshot({
        delegationId: 'test-delegation',
        localPath,
      });
      const snapshot1 = JSON.parse(result1.snapshotBase64);

      const response1 = await fetch(snapshot1.resultUrl);
      expect(response1.ok).toBe(true);
      const buffer1 = Buffer.from(await response1.arrayBuffer());
      const verifyZip1 = path.join(tempDir, 'verify-round1.zip');
      await fs.promises.writeFile(verifyZip1, buffer1);
      const verifyDir1 = path.join(tempDir, 'verify-round1');
      await extractArchive(verifyZip1, verifyDir1);
      expect(await fs.promises.readFile(path.join(verifyDir1, 'file.txt'), 'utf-8')).toBe('round 1 content');

      await executor.detach({ delegationId: 'test-delegation', localPath });

      await fs.promises.writeFile(path.join(localPath, 'file.txt'), 'round 2 content');
      const result2 = await executor.captureSnapshot({
        delegationId: 'test-delegation',
        localPath,
      });
      const snapshot2 = JSON.parse(result2.snapshotBase64);

      const response2 = await fetch(snapshot2.resultUrl);
      expect(response2.ok).toBe(true);
      const buffer2 = Buffer.from(await response2.arrayBuffer());
      const verifyZip2 = path.join(tempDir, 'verify-round2.zip');
      await fs.promises.writeFile(verifyZip2, buffer2);
      const verifyDir2 = path.join(tempDir, 'verify-round2');
      await extractArchive(verifyZip2, verifyDir2);
      expect(await fs.promises.readFile(path.join(verifyDir2, 'file.txt'), 'utf-8')).toBe('round 2 content');
    });

    it('should support full multi-round lifecycle: setup → round1 → detach → round2 → detach → release', async () => {
      const exportDir = path.join(tempDir, 'export');
      await fs.promises.mkdir(exportDir, { recursive: true });
      await fs.promises.writeFile(path.join(exportDir, 'version.txt'), 'v1');

      const handle = await delegator.prepare({
        delegationId: 'test-delegation',
        exportPath: exportDir,
        ttlSeconds: 300,
      });

      const localPath = path.join(tempDir, 'work');
      await executor.setup({ delegationId: 'test-delegation', handle, localPath });

      await fs.promises.writeFile(path.join(localPath, 'version.txt'), 'v2');
      const result1 = await executor.captureSnapshot({
        delegationId: 'test-delegation',
        localPath,
      });
      const snapshot1 = JSON.parse(result1.snapshotBase64);
      expect(snapshot1.resultUrl).toContain('http://localhost');

      await executor.detach({ delegationId: 'test-delegation', localPath });

      await fs.promises.writeFile(path.join(localPath, 'version.txt'), 'v3');
      const result2 = await executor.captureSnapshot({
        delegationId: 'test-delegation',
        localPath,
      });
      const snapshot2 = JSON.parse(result2.snapshotBase64);
      expect(snapshot2.resultUrl).toContain('http://localhost');

      await executor.detach({ delegationId: 'test-delegation', localPath });

      await executor.release({ delegationId: 'test-delegation', localPath });

      const result3 = await executor.captureSnapshot({
        delegationId: 'test-delegation',
        localPath,
      });
      expect(() => JSON.parse(result3.snapshotBase64)).toThrow();
    });
  });
});

describe('LocalStorageProvider', () => {
  let tempDir: string;
  let provider: LocalStorageProvider;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'awcp-storage-test-'));
    provider = new LocalStorageProvider({
      baseDir: tempDir,
      baseUrl: 'http://localhost:8080',
    });
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('should upload a file and return URLs', async () => {
    const data = Buffer.from('test content');
    const result = await provider.upload('test/file.zip', data, 300);

    expect(result.downloadUrl).toBe('http://localhost:8080/test/file.zip');
    expect(result.uploadUrl).toBe('http://localhost:8080/test/file-result.zip');
    expect(result.expiresAt).toBeDefined();

    const written = await fs.promises.readFile(path.join(tempDir, 'test/file.zip'));
    expect(written).toEqual(data);
  });

  it('should generate URLs without writing files', async () => {
    const result = await provider.generateUrls('workspaces/abc.zip', 600);

    expect(result.downloadUrl).toBe('http://localhost:8080/workspaces/abc.zip');
    expect(result.uploadUrl).toBe('http://localhost:8080/workspaces/abc-result.zip');
  });

  it('should release files', async () => {
    const data = Buffer.from('test');
    await provider.upload('release-test.zip', data, 300);

    const existsBefore = await fs.promises.access(path.join(tempDir, 'release-test.zip')).then(() => true).catch(() => false);
    expect(existsBefore).toBe(true);

    await provider.release('release-test.zip');

    const existsAfter = await fs.promises.access(path.join(tempDir, 'release-test.zip')).then(() => true).catch(() => false);
    expect(existsAfter).toBe(false);
  });
});
