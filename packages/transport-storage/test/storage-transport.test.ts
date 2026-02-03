import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { StorageTransport } from '../src/storage-transport.js';
import { LocalStorageProvider } from '../src/delegator/local-storage.js';

describe('StorageTransport', () => {
  let tempDir: string;
  let storageDir: string;
  let server: http.Server;
  let serverPort: number;
  let transport: StorageTransport;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'awcp-storage-test-'));
    storageDir = path.join(tempDir, 'storage');
    await fs.promises.mkdir(storageDir, { recursive: true });

    // Start a simple HTTP server to serve and accept files
    server = http.createServer(async (req, res) => {
      const filePath = path.join(storageDir, req.url!);
      
      if (req.method === 'PUT') {
        // Handle file uploads
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', async () => {
          try {
            const dir = path.dirname(filePath);
            await fs.promises.mkdir(dir, { recursive: true });
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
      
      // Handle file downloads (GET)
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

    transport = new StorageTransport({
      delegator: {
        tempDir,
        provider: {
          type: 'local',
          localDir: storageDir,
          endpoint: `http://localhost:${serverPort}`,
        },
      },
      executor: { tempDir },
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('should report dependencies as available', async () => {
    const result = await transport.checkDependency();
    expect(result.available).toBe(true);
  });

  it('should prepare and setup a workspace', async () => {
    const exportDir = path.join(tempDir, 'export');
    await fs.promises.mkdir(exportDir, { recursive: true });
    await fs.promises.writeFile(path.join(exportDir, 'test.txt'), 'hello world');
    await fs.promises.mkdir(path.join(exportDir, 'subdir'));
    await fs.promises.writeFile(path.join(exportDir, 'subdir', 'nested.txt'), 'nested');

    const prepareResult = await transport.prepare({
      delegationId: 'test-delegation',
      exportPath: exportDir,
      ttlSeconds: 300,
    });

    expect(prepareResult.workDirInfo.transport).toBe('storage');
    const storageInfo = prepareResult.workDirInfo as import('@awcp/core').StorageWorkDirInfo;
    expect(storageInfo.downloadUrl).toContain('http://localhost');
    expect(storageInfo.checksum).toMatch(/^[a-f0-9]{64}$/);

    const workDir = path.join(tempDir, 'work');
    const resultPath = await transport.setup({
      delegationId: 'test-delegation',
      workDirInfo: prepareResult.workDirInfo,
      workDir,
    });

    expect(resultPath).toBe(workDir);

    const testContent = await fs.promises.readFile(path.join(workDir, 'test.txt'), 'utf-8');
    expect(testContent).toBe('hello world');

    const nestedContent = await fs.promises.readFile(path.join(workDir, 'subdir', 'nested.txt'), 'utf-8');
    expect(nestedContent).toBe('nested');
  });

  it('should complete full delegation flow with teardown', async () => {
    const exportDir = path.join(tempDir, 'export');
    await fs.promises.mkdir(exportDir, { recursive: true });
    await fs.promises.writeFile(path.join(exportDir, 'original.txt'), 'original content');

    const prepareResult = await transport.prepare({
      delegationId: 'test-delegation',
      exportPath: exportDir,
      ttlSeconds: 300,
    });

    const workDir = path.join(tempDir, 'work');
    await transport.setup({
      delegationId: 'test-delegation',
      workDirInfo: prepareResult.workDirInfo,
      workDir,
    });

    await fs.promises.writeFile(path.join(workDir, 'original.txt'), 'modified content');
    await fs.promises.writeFile(path.join(workDir, 'new-file.txt'), 'new file content');

    const teardownResult = await transport.teardown({
      delegationId: 'test-delegation',
      workDir,
    });

    expect(teardownResult.resultBase64).toBeDefined();
    expect(teardownResult.resultBase64!.length).toBeGreaterThan(0);
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

  it('should cleanup files', async () => {
    const data = Buffer.from('test');
    await provider.upload('cleanup-test.zip', data, 300);

    const existsBefore = await fs.promises.access(path.join(tempDir, 'cleanup-test.zip')).then(() => true).catch(() => false);
    expect(existsBefore).toBe(true);

    await provider.cleanup('cleanup-test.zip');

    const existsAfter = await fs.promises.access(path.join(tempDir, 'cleanup-test.zip')).then(() => true).catch(() => false);
    expect(existsAfter).toBe(false);
  });
});
