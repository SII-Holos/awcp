import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ArchiveCreator } from '../src/delegator/archive-creator.js';
import { ArchiveExtractor } from '../src/executor/archive-extractor.js';

describe('ArchiveCreator', () => {
  let tempDir: string;
  let creator: ArchiveCreator;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'awcp-test-'));
    creator = new ArchiveCreator({ tempDir });
  });

  afterEach(async () => {
    await creator.cleanupAll();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('should create a ZIP archive from a directory', async () => {
    // Create test directory with files
    const sourceDir = path.join(tempDir, 'source');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'test.txt'), 'hello world');
    await fs.promises.mkdir(path.join(sourceDir, 'subdir'));
    await fs.promises.writeFile(path.join(sourceDir, 'subdir', 'nested.txt'), 'nested content');

    const result = await creator.create('test-delegation', sourceDir);

    expect(result.archivePath).toContain('test-delegation.zip');
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sizeBytes).toBeGreaterThan(0);

    // Verify archive exists
    const exists = await fs.promises
      .access(result.archivePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it('should track and cleanup archives', async () => {
    const sourceDir = path.join(tempDir, 'source');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'test.txt'), 'hello');

    const result = await creator.create('test-delegation', sourceDir);

    // Verify archive was created
    const existsBefore = await fs.promises
      .access(result.archivePath)
      .then(() => true)
      .catch(() => false);
    expect(existsBefore).toBe(true);

    await creator.cleanup('test-delegation');

    // Verify archive was removed
    const existsAfter = await fs.promises
      .access(result.archivePath)
      .then(() => true)
      .catch(() => false);
    expect(existsAfter).toBe(false);
  });
});

describe('ArchiveExtractor', () => {
  let tempDir: string;
  let extractor: ArchiveExtractor;
  let creator: ArchiveCreator;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'awcp-test-'));
    extractor = new ArchiveExtractor();
    creator = new ArchiveCreator({ tempDir });
  });

  afterEach(async () => {
    await creator.cleanupAll();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('should extract a ZIP archive to a directory', async () => {
    // Create source and archive it
    const sourceDir = path.join(tempDir, 'source');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'test.txt'), 'hello world');
    await fs.promises.mkdir(path.join(sourceDir, 'subdir'));
    await fs.promises.writeFile(path.join(sourceDir, 'subdir', 'nested.txt'), 'nested content');

    const result = await creator.create('test-delegation', sourceDir);

    // Extract to new directory
    const targetDir = path.join(tempDir, 'target');
    await extractor.extract(result.archivePath, targetDir);

    // Verify extracted contents
    const testContent = await fs.promises.readFile(path.join(targetDir, 'test.txt'), 'utf-8');
    expect(testContent).toBe('hello world');

    const nestedContent = await fs.promises.readFile(
      path.join(targetDir, 'subdir', 'nested.txt'),
      'utf-8',
    );
    expect(nestedContent).toBe('nested content');
  });

  it('should create an archive from a directory', async () => {
    const sourceDir = path.join(tempDir, 'source');
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'test.txt'), 'hello world');

    const archivePath = path.join(tempDir, 'output.zip');
    await extractor.createArchive(sourceDir, archivePath);

    // Verify archive exists and can be extracted
    const targetDir = path.join(tempDir, 'verify');
    await extractor.extract(archivePath, targetDir);

    const content = await fs.promises.readFile(path.join(targetDir, 'test.txt'), 'utf-8');
    expect(content).toBe('hello world');
  });
});
