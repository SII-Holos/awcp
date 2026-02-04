import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ArchiveTransport } from '../src/archive-transport.js';
import { extractArchive } from '../src/utils/index.js';

describe('ArchiveTransport', () => {
  let tempDir: string;
  let transport: ArchiveTransport;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'awcp-test-'));
    transport = new ArchiveTransport({
      delegator: { tempDir },
      executor: { tempDir },
    });
  });

  afterEach(async () => {
    await transport.shutdown();
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

    expect(prepareResult.workDirInfo.transport).toBe('archive');
    const archiveInfo = prepareResult.workDirInfo as import('@awcp/core').ArchiveWorkDirInfo;
    expect(archiveInfo.workspaceBase64).toBeDefined();
    expect(archiveInfo.checksum).toMatch(/^[a-f0-9]{64}$/);

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

  it('should complete full delegation flow with changes', async () => {
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

    expect(teardownResult.snapshotBase64).toBeDefined();
    expect(teardownResult.snapshotBase64!.length).toBeGreaterThan(0);

    const resultBuffer = Buffer.from(teardownResult.snapshotBase64!, 'base64');
    const resultPath = path.join(tempDir, 'result.zip');
    await fs.promises.writeFile(resultPath, resultBuffer);

    const resultDir = path.join(tempDir, 'result');
    await extractArchive(resultPath, resultDir);

    const modifiedContent = await fs.promises.readFile(path.join(resultDir, 'original.txt'), 'utf-8');
    expect(modifiedContent).toBe('modified content');

    const newContent = await fs.promises.readFile(path.join(resultDir, 'new-file.txt'), 'utf-8');
    expect(newContent).toBe('new file content');
  });
});
