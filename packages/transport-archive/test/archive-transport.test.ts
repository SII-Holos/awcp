import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ArchiveDelegatorTransport } from '../src/delegator/transport.js';
import { ArchiveExecutorTransport } from '../src/executor/transport.js';
import { extractArchive } from '../src/utils/index.js';
import type { ArchiveTransportHandle } from '@awcp/core';

describe('ArchiveDelegatorTransport', () => {
  let tempDir: string;
  let transport: ArchiveDelegatorTransport;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'awcp-test-'));
    transport = new ArchiveDelegatorTransport({ tempDir });
    await transport.initialize();
  });

  afterEach(async () => {
    await transport.shutdown();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('should prepare a workspace and return ArchiveTransportHandle', async () => {
    const exportDir = path.join(tempDir, 'export');
    await fs.promises.mkdir(exportDir, { recursive: true });
    await fs.promises.writeFile(path.join(exportDir, 'test.txt'), 'hello world');
    await fs.promises.mkdir(path.join(exportDir, 'subdir'));
    await fs.promises.writeFile(path.join(exportDir, 'subdir', 'nested.txt'), 'nested');

    const handle = await transport.prepare({
      delegationId: 'test-delegation',
      exportPath: exportDir,
      ttlSeconds: 300,
    });

    expect(handle.transport).toBe('archive');
    const archiveHandle = handle as ArchiveTransportHandle;
    expect(archiveHandle.workspaceBase64).toBeDefined();
    expect(archiveHandle.checksum).toMatch(/^[a-f0-9]{64}$/);
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

  it('should apply a snapshot back to resources', async () => {
    const sourceDir = path.join(tempDir, 'source');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'file.txt'), 'original');

    const exportDir = path.join(tempDir, 'export');
    await fs.promises.mkdir(path.join(exportDir, 'workspace'), { recursive: true });
    await fs.promises.writeFile(path.join(exportDir, 'workspace', 'file.txt'), 'modified');

    const { createArchive } = await import('../src/utils/index.js');
    const archivePath = path.join(tempDir, 'snapshot.zip');
    await createArchive(exportDir, archivePath);
    const buffer = await fs.promises.readFile(archivePath);
    const snapshotData = buffer.toString('base64');

    await transport.applySnapshot({
      delegationId: 'test-delegation',
      snapshotData,
      resources: [{ name: 'workspace', source: sourceDir, mode: 'rw' }],
    });

    const content = await fs.promises.readFile(path.join(sourceDir, 'file.txt'), 'utf-8');
    expect(content).toBe('modified');
  });
});

describe('ArchiveExecutorTransport', () => {
  let tempDir: string;
  let transport: ArchiveExecutorTransport;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'awcp-test-'));
    transport = new ArchiveExecutorTransport({ tempDir });
    await transport.initialize();
  });

  afterEach(async () => {
    await transport.shutdown();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('should report dependencies as available', async () => {
    const result = await transport.checkDependency();
    expect(result.available).toBe(true);
  });

  it('should setup a workspace from handle', async () => {
    const exportDir = path.join(tempDir, 'export');
    await fs.promises.mkdir(exportDir, { recursive: true });
    await fs.promises.writeFile(path.join(exportDir, 'test.txt'), 'hello world');
    await fs.promises.mkdir(path.join(exportDir, 'subdir'));
    await fs.promises.writeFile(path.join(exportDir, 'subdir', 'nested.txt'), 'nested');

    const delegator = new ArchiveDelegatorTransport({ tempDir });
    await delegator.initialize();
    const handle = await delegator.prepare({
      delegationId: 'test-delegation',
      exportPath: exportDir,
      ttlSeconds: 300,
    });

    const localPath = path.join(tempDir, 'work');
    const resultPath = await transport.setup({
      delegationId: 'test-delegation',
      handle,
      localPath,
    });

    expect(resultPath).toBe(localPath);
    expect(await fs.promises.readFile(path.join(localPath, 'test.txt'), 'utf-8')).toBe('hello world');
    expect(await fs.promises.readFile(path.join(localPath, 'subdir', 'nested.txt'), 'utf-8')).toBe('nested');
  });

  it('should capture snapshot of modified workspace', async () => {
    const exportDir = path.join(tempDir, 'export');
    await fs.promises.mkdir(exportDir, { recursive: true });
    await fs.promises.writeFile(path.join(exportDir, 'original.txt'), 'original content');

    const delegator = new ArchiveDelegatorTransport({ tempDir });
    await delegator.initialize();
    const handle = await delegator.prepare({
      delegationId: 'test-delegation',
      exportPath: exportDir,
      ttlSeconds: 300,
    });

    const localPath = path.join(tempDir, 'work');
    await transport.setup({ delegationId: 'test-delegation', handle, localPath });

    await fs.promises.writeFile(path.join(localPath, 'original.txt'), 'modified content');
    await fs.promises.writeFile(path.join(localPath, 'new-file.txt'), 'new file content');

    const result = await transport.captureSnapshot({
      delegationId: 'test-delegation',
      localPath,
    });

    expect(result.snapshotBase64).toBeDefined();
    expect(result.snapshotBase64.length).toBeGreaterThan(0);

    const resultBuffer = Buffer.from(result.snapshotBase64, 'base64');
    const resultZip = path.join(tempDir, 'result.zip');
    await fs.promises.writeFile(resultZip, resultBuffer);
    const resultDir = path.join(tempDir, 'result');
    await extractArchive(resultZip, resultDir);

    expect(await fs.promises.readFile(path.join(resultDir, 'original.txt'), 'utf-8')).toBe('modified content');
    expect(await fs.promises.readFile(path.join(resultDir, 'new-file.txt'), 'utf-8')).toBe('new file content');
  });

  it('should clean up temp ZIP after setup and captureSnapshot', async () => {
    const exportDir = path.join(tempDir, 'export');
    await fs.promises.mkdir(exportDir, { recursive: true });
    await fs.promises.writeFile(path.join(exportDir, 'test.txt'), 'hello');

    const delegator = new ArchiveDelegatorTransport({ tempDir });
    await delegator.initialize();
    const handle = await delegator.prepare({
      delegationId: 'test-delegation',
      exportPath: exportDir,
      ttlSeconds: 300,
    });

    const localPath = path.join(tempDir, 'work');
    await transport.setup({ delegationId: 'test-delegation', handle, localPath });
    await transport.captureSnapshot({ delegationId: 'test-delegation', localPath });

    const files = await fs.promises.readdir(tempDir);
    const zips = files.filter(f => f.endsWith('.zip'));
    expect(zips).toHaveLength(0);
  });
});
