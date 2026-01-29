/**
 * Admission Control Tests
 * 
 * Tests for workspace admission control that validates size and file count limits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

      const result = await controller.check(testDir);
      expect(result.allowed).toBe(true);
      expect(result.stats?.fileCount).toBe(5);
      expect(result.stats?.estimatedBytes).toBe(500);
    });
  });

  describe('custom limits', () => {
    it('should reject when file count exceeds limit', async () => {
      const controller = new AdmissionController({
        maxFileCount: 3,
      });
      await createFiles(5, 100); // 5 files > limit of 3

      const result = await controller.check(testDir);
      expect(result.allowed).toBe(false);
      expect(result.hint).toContain('File count');
      expect(result.hint).toContain('5');
      expect(result.hint).toContain('3');
    });

    it('should reject when total size exceeds limit', async () => {
      const controller = new AdmissionController({
        maxTotalBytes: 1024, // 1KB
      });
      await createFiles(2, 1000); // 2000 bytes > 1024

      const result = await controller.check(testDir);
      expect(result.allowed).toBe(false);
      expect(result.hint).toContain('size');
      expect(result.hint).toContain('exceeds');
    });

    it('should reject when single file exceeds limit', async () => {
      const controller = new AdmissionController({
        maxSingleFileBytes: 512,
      });
      await createFiles(1, 1000); // 1000 bytes > 512

      const result = await controller.check(testDir);
      expect(result.allowed).toBe(false);
      expect(result.hint).toContain('Largest file');
    });

    it('should pass when within all limits', async () => {
      const controller = new AdmissionController({
        maxTotalBytes: 1024,
        maxFileCount: 5,
        maxSingleFileBytes: 500,
      });
      await createFiles(2, 100); // 200 bytes, 2 files, max 100 each

      const result = await controller.check(testDir);
      expect(result.allowed).toBe(true);
    });
  });

  describe('statistics', () => {
    it('should return accurate file statistics', async () => {
      const controller = new AdmissionController();
      await createFiles(3, 100);
      await writeFile(join(testDir, 'large.txt'), 'x'.repeat(500));

      const result = await controller.check(testDir);
      expect(result.stats?.fileCount).toBe(4);
      expect(result.stats?.estimatedBytes).toBe(800); // 3*100 + 500
      expect(result.stats?.largestFileBytes).toBe(500);
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

      const result = await controller.check(testDir);
      expect(result.allowed).toBe(true);
      expect(result.stats?.fileCount).toBe(2); // Only counts regular files
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

      const result = await controller.check(testDir);
      expect(result.allowed).toBe(true);
      expect(result.stats?.fileCount).toBe(2);
    });
  });

  describe('custom check function', () => {
    it('should use custom check when provided', async () => {
      const controller = new AdmissionController({
        customCheck: async () => ({
          allowed: false,
          hint: 'Custom rejection reason',
        }),
      });
      await createFiles(1, 10);

      const result = await controller.check(testDir);
      expect(result.allowed).toBe(false);
      expect(result.hint).toBe('Custom rejection reason');
    });
  });

  describe('error handling', () => {
    it('should handle non-existent directory gracefully', async () => {
      const controller = new AdmissionController();
      
      const result = await controller.check('/non/existent/path');
      // Should allow by default (fail open)
      expect(result.allowed).toBe(true);
    });
  });
});
