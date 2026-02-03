import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createArchive, extractArchive } from '../src/utils/index.js';

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
});
