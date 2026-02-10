/**
 * Admission Control Tests
 * 
 * Tests for workspace admission control that validates size and file count limits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceTooLargeError, SensitiveFilesError } from '@awcp/core';
import { AdmissionController } from '../../src/delegator/admission.js';

describe('AdmissionController', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `awcp-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function createFiles(count: number, sizeEach: number) {
    for (let i = 0; i < count; i++) {
      const content = 'x'.repeat(sizeEach);
      await writeFile(join(testDir, `file${i}.txt`), content);
    }
  }

  describe('default limits', () => {
    it('should allow small workspaces by default', async () => {
      const controller = new AdmissionController();
      await createFiles(5, 100); // 500 bytes, 5 files

      const stats = await controller.check(testDir);
      expect(stats.fileCount).toBe(5);
      expect(stats.estimatedBytes).toBe(500);
    });
  });

  describe('custom limits', () => {
    it('should reject when file count exceeds limit', async () => {
      const controller = new AdmissionController({
        maxFileCount: 3,
      });
      await createFiles(5, 100); // 5 files > limit of 3

      const error = await controller.check(testDir).catch((e) => e);
      expect(error).toBeInstanceOf(WorkspaceTooLargeError);
      expect(error.hint).toMatch(/File count/);
    });

    it('should reject when total size exceeds limit', async () => {
      const controller = new AdmissionController({
        maxTotalBytes: 1024, // 1KB
      });
      await createFiles(2, 1000); // 2000 bytes > 1024

      const error = await controller.check(testDir).catch((e) => e);
      expect(error).toBeInstanceOf(WorkspaceTooLargeError);
      expect(error.hint).toMatch(/exceeds/);
    });

    it('should reject when single file exceeds limit', async () => {
      const controller = new AdmissionController({
        maxSingleFileBytes: 512,
      });
      await createFiles(1, 1000); // 1000 bytes > 512

      const error = await controller.check(testDir).catch((e) => e);
      expect(error).toBeInstanceOf(WorkspaceTooLargeError);
      expect(error.hint).toMatch(/Largest file/);
    });

    it('should pass when within all limits', async () => {
      const controller = new AdmissionController({
        maxTotalBytes: 1024,
        maxFileCount: 5,
        maxSingleFileBytes: 500,
      });
      await createFiles(2, 100); // 200 bytes, 2 files, max 100 each

      const stats = await controller.check(testDir);
      expect(stats.fileCount).toBe(2);
    });
  });

  describe('statistics', () => {
    it('should return accurate file statistics', async () => {
      const controller = new AdmissionController();
      await createFiles(3, 100);
      await writeFile(join(testDir, 'large.txt'), 'x'.repeat(500));

      const stats = await controller.check(testDir);
      expect(stats.fileCount).toBe(4);
      expect(stats.estimatedBytes).toBe(800); // 3*100 + 500
      expect(stats.largestFileBytes).toBe(500);
    });
  });

  describe('special directories', () => {
    it('should skip node_modules directory', async () => {
      const controller = new AdmissionController({
        maxFileCount: 3,
      });
      
      // Create 2 regular files
      await createFiles(2, 100);
      
      // Create node_modules with many files (should be skipped)
      const nodeModules = join(testDir, 'node_modules');
      await mkdir(nodeModules, { recursive: true });
      for (let i = 0; i < 10; i++) {
        await writeFile(join(nodeModules, `dep${i}.js`), 'module.exports = {}');
      }

      const stats = await controller.check(testDir);
      expect(stats.fileCount).toBe(2); // Only counts regular files
    });

    it('should skip .git directory', async () => {
      const controller = new AdmissionController({
        maxFileCount: 3,
      });
      
      await createFiles(2, 100);
      
      const gitDir = join(testDir, '.git');
      await mkdir(gitDir, { recursive: true });
      for (let i = 0; i < 10; i++) {
        await writeFile(join(gitDir, `object${i}`), 'git object');
      }

      const stats = await controller.check(testDir);
      expect(stats.fileCount).toBe(2);
    });
  });

  describe('error details', () => {
    it('should include stats and hint in WorkspaceTooLargeError', async () => {
      const controller = new AdmissionController({
        maxFileCount: 2,
      });
      await createFiles(5, 100);

      try {
        await controller.check(testDir, 'test-delegation-id');
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceTooLargeError);
        const wsError = error as WorkspaceTooLargeError;
        expect(wsError.stats.fileCount).toBe(5);
        expect(wsError.hint).toContain('File count');
        expect(wsError.delegationId).toBe('test-delegation-id');
      }
    });
  });

  describe('sensitive file detection', () => {
    it('should reject workspace with .env file', async () => {
      const controller = new AdmissionController();
      await createFiles(1, 100);
      await writeFile(join(testDir, '.env'), 'SECRET=abc');

      const error = await controller.check(testDir).catch((e) => e);
      expect(error).toBeInstanceOf(SensitiveFilesError);
      expect(error.files).toContain('.env');
    });

    it('should reject workspace with .env.local variant', async () => {
      const controller = new AdmissionController();
      await createFiles(1, 100);
      await writeFile(join(testDir, '.env.local'), 'SECRET=abc');

      const error = await controller.check(testDir).catch((e) => e);
      expect(error).toBeInstanceOf(SensitiveFilesError);
      expect(error.files).toContain('.env.local');
    });

    it('should reject workspace with private key files', async () => {
      const controller = new AdmissionController();
      await createFiles(1, 100);
      await writeFile(join(testDir, 'server.pem'), 'key data');
      await writeFile(join(testDir, 'cert.key'), 'key data');

      const error = await controller.check(testDir).catch((e) => e);
      expect(error).toBeInstanceOf(SensitiveFilesError);
      expect(error.files).toContain('server.pem');
      expect(error.files).toContain('cert.key');
    });

    it('should detect sensitive files in subdirectories', async () => {
      const controller = new AdmissionController();
      const subDir = join(testDir, 'config');
      await mkdir(subDir, { recursive: true });
      await writeFile(join(subDir, 'credentials.json'), '{}');

      const error = await controller.check(testDir).catch((e) => e);
      expect(error).toBeInstanceOf(SensitiveFilesError);
      expect(error.files).toContain(join('config', 'credentials.json'));
    });

    it('should allow workspace with custom patterns', async () => {
      const controller = new AdmissionController({
        sensitivePatterns: ['*.secret'],
      });
      await writeFile(join(testDir, '.env'), 'SECRET=abc');
      await writeFile(join(testDir, 'app.txt'), 'hello');

      // .env not in custom patterns, should pass
      const stats = await controller.check(testDir);
      expect(stats.fileCount).toBe(2);
    });

    it('should reject with custom patterns', async () => {
      const controller = new AdmissionController({
        sensitivePatterns: ['*.secret'],
      });
      await writeFile(join(testDir, 'db.secret'), 'password');

      const error = await controller.check(testDir).catch((e) => e);
      expect(error).toBeInstanceOf(SensitiveFilesError);
      expect(error.files).toContain('db.secret');
    });

    it('should skip sensitive check when skipSensitiveCheck is true', async () => {
      const controller = new AdmissionController({
        skipSensitiveCheck: true,
      });
      await writeFile(join(testDir, '.env'), 'SECRET=abc');

      const stats = await controller.check(testDir);
      expect(stats.fileCount).toBe(1);
      expect(stats.sensitiveFiles).toContain('.env');
    });

    it('should include delegationId in SensitiveFilesError', async () => {
      const controller = new AdmissionController();
      await writeFile(join(testDir, '.env'), 'SECRET=abc');

      try {
        await controller.check(testDir, 'test-id');
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SensitiveFilesError);
        expect((error as SensitiveFilesError).delegationId).toBe('test-id');
      }
    });
  });

  describe('error handling', () => {
    it('should handle non-existent directory gracefully', async () => {
      const controller = new AdmissionController();
      
      // Should not throw (fail open)
      const stats = await controller.check('/non/existent/path');
      expect(stats).toBeDefined();
    });
  });
});
