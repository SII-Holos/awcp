import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createArchive, extractArchive, applyResultToResources } from '../src/utils/index.js';

describe('Archive Utils', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'awcp-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('createArchive', () => {
    it('should create a ZIP archive from a directory', async () => {
      const sourceDir = path.join(tempDir, 'source');
      await fs.promises.mkdir(sourceDir, { recursive: true });
      await fs.promises.writeFile(path.join(sourceDir, 'test.txt'), 'hello world');
      await fs.promises.mkdir(path.join(sourceDir, 'subdir'));
      await fs.promises.writeFile(path.join(sourceDir, 'subdir', 'nested.txt'), 'nested content');

      const archivePath = path.join(tempDir, 'test.zip');
      await createArchive(sourceDir, archivePath);

      const exists = await fs.promises.access(archivePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      const stats = await fs.promises.stat(archivePath);
      expect(stats.size).toBeGreaterThan(0);
    });

    it('should exclude .awcp directory by default', async () => {
      const sourceDir = path.join(tempDir, 'source');
      await fs.promises.mkdir(sourceDir, { recursive: true });
      await fs.promises.writeFile(path.join(sourceDir, 'test.txt'), 'hello');
      await fs.promises.mkdir(path.join(sourceDir, '.awcp'));
      await fs.promises.writeFile(path.join(sourceDir, '.awcp', 'manifest.json'), '{}');

      const archivePath = path.join(tempDir, 'test.zip');
      await createArchive(sourceDir, archivePath);

      const targetDir = path.join(tempDir, 'extracted');
      await extractArchive(archivePath, targetDir);

      const awcpExists = await fs.promises.access(path.join(targetDir, '.awcp')).then(() => true).catch(() => false);
      expect(awcpExists).toBe(false);

      const testExists = await fs.promises.access(path.join(targetDir, 'test.txt')).then(() => true).catch(() => false);
      expect(testExists).toBe(true);
    });
  });

  describe('extractArchive', () => {
    it('should extract a ZIP archive to a directory', async () => {
      const sourceDir = path.join(tempDir, 'source');
      await fs.promises.mkdir(sourceDir, { recursive: true });
      await fs.promises.writeFile(path.join(sourceDir, 'test.txt'), 'hello world');
      await fs.promises.mkdir(path.join(sourceDir, 'subdir'));
      await fs.promises.writeFile(path.join(sourceDir, 'subdir', 'nested.txt'), 'nested content');

      const archivePath = path.join(tempDir, 'test.zip');
      await createArchive(sourceDir, archivePath);

      const targetDir = path.join(tempDir, 'target');
      await extractArchive(archivePath, targetDir);

      const testContent = await fs.promises.readFile(path.join(targetDir, 'test.txt'), 'utf-8');
      expect(testContent).toBe('hello world');

      const nestedContent = await fs.promises.readFile(path.join(targetDir, 'subdir', 'nested.txt'), 'utf-8');
      expect(nestedContent).toBe('nested content');
    });
  });

  describe('applyResultToResources', () => {
    it('should remove deleted files from target directory', async () => {
      // Setup: create original target directory with files
      const targetDir = path.join(tempDir, 'target-resource');
      await fs.promises.mkdir(targetDir, { recursive: true });
      await fs.promises.writeFile(path.join(targetDir, 'keep.txt'), 'keep this');
      await fs.promises.writeFile(path.join(targetDir, 'delete-me.txt'), 'this will be deleted');
      await fs.promises.mkdir(path.join(targetDir, 'subdir'));
      await fs.promises.writeFile(path.join(targetDir, 'subdir', 'also-delete.txt'), 'also deleted');

      // Create extract directory simulating executor result (without deleted files)
      const extractDir = path.join(tempDir, 'extract');
      const resourceDir = path.join(extractDir, 'my-resource');
      await fs.promises.mkdir(resourceDir, { recursive: true });
      await fs.promises.writeFile(path.join(resourceDir, 'keep.txt'), 'modified content');
      await fs.promises.writeFile(path.join(resourceDir, 'new-file.txt'), 'new file');

      // Apply snapshot
      await applyResultToResources(extractDir, [
        { name: 'my-resource', source: targetDir, mode: 'rw' },
      ]);

      // Verify: kept file is updated
      const keepContent = await fs.promises.readFile(path.join(targetDir, 'keep.txt'), 'utf-8');
      expect(keepContent).toBe('modified content');

      // Verify: new file exists
      const newFileExists = await fs.promises.access(path.join(targetDir, 'new-file.txt')).then(() => true).catch(() => false);
      expect(newFileExists).toBe(true);

      // Verify: deleted files are gone
      const deletedFileExists = await fs.promises.access(path.join(targetDir, 'delete-me.txt')).then(() => true).catch(() => false);
      expect(deletedFileExists).toBe(false);

      const deletedDirExists = await fs.promises.access(path.join(targetDir, 'subdir')).then(() => true).catch(() => false);
      expect(deletedDirExists).toBe(false);
    });

    it('should not affect ro resources', async () => {
      const targetDir = path.join(tempDir, 'ro-resource');
      await fs.promises.mkdir(targetDir, { recursive: true });
      await fs.promises.writeFile(path.join(targetDir, 'original.txt'), 'original');

      const extractDir = path.join(tempDir, 'extract');
      const resourceDir = path.join(extractDir, 'ro-resource');
      await fs.promises.mkdir(resourceDir, { recursive: true });
      await fs.promises.writeFile(path.join(resourceDir, 'original.txt'), 'modified');

      await applyResultToResources(extractDir, [
        { name: 'ro-resource', source: targetDir, mode: 'ro' },
      ]);

      // ro resource should not be modified
      const content = await fs.promises.readFile(path.join(targetDir, 'original.txt'), 'utf-8');
      expect(content).toBe('original');
    });
  });
});
