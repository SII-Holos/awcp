/**
 * ID Generation Tests
 */

import { describe, it, expect } from 'vitest';
import {
  generateId,
  generateDelegationId,
  generateSnapshotId,
  generateTaskId,
} from '../src/utils/id.js';

describe('generateId', () => {
  describe('default behavior', () => {
    it('should generate medium length ID without prefix', () => {
      const id = generateId();
      expect(id).toMatch(/^[a-f0-9]{12}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('with prefix', () => {
    it('should add prefix with underscore separator', () => {
      const id = generateId({ prefix: 'test' });
      expect(id).toMatch(/^test_[a-f0-9]{12}$/);
    });

    it('should handle empty prefix', () => {
      const id = generateId({ prefix: '' });
      expect(id).toMatch(/^[a-f0-9]{12}$/);
    });
  });

  describe('length options', () => {
    it('should generate short ID (8 chars)', () => {
      const id = generateId({ length: 'short' });
      expect(id).toMatch(/^[a-f0-9]{8}$/);
    });

    it('should generate medium ID (12 chars)', () => {
      const id = generateId({ length: 'medium' });
      expect(id).toMatch(/^[a-f0-9]{12}$/);
    });

    it('should generate long ID (16 chars)', () => {
      const id = generateId({ length: 'long' });
      expect(id).toMatch(/^[a-f0-9]{16}$/);
    });

    it('should generate full ID (32 chars, UUID without hyphens)', () => {
      const id = generateId({ length: 'full' });
      expect(id).toMatch(/^[a-f0-9]{32}$/);
    });
  });

  describe('combined options', () => {
    it('should work with prefix and short length', () => {
      const id = generateId({ prefix: 'x', length: 'short' });
      expect(id).toMatch(/^x_[a-f0-9]{8}$/);
    });

    it('should work with prefix and full length', () => {
      const id = generateId({ prefix: 'full', length: 'full' });
      expect(id).toMatch(/^full_[a-f0-9]{32}$/);
    });
  });
});

describe('generateDelegationId', () => {
  it('should generate with dlg prefix and full length by default', () => {
    const id = generateDelegationId();
    expect(id).toMatch(/^dlg_[a-f0-9]{32}$/);
  });

  it('should respect custom length', () => {
    const id = generateDelegationId('short');
    expect(id).toMatch(/^dlg_[a-f0-9]{8}$/);
  });
});

describe('generateSnapshotId', () => {
  it('should generate with snap prefix and medium length by default', () => {
    const id = generateSnapshotId();
    expect(id).toMatch(/^snap_[a-f0-9]{12}$/);
  });

  it('should respect custom length', () => {
    const id = generateSnapshotId('long');
    expect(id).toMatch(/^snap_[a-f0-9]{16}$/);
  });
});

describe('generateTaskId', () => {
  it('should generate with task prefix and medium length by default', () => {
    const id = generateTaskId();
    expect(id).toMatch(/^task_[a-f0-9]{12}$/);
  });

  it('should respect custom length', () => {
    const id = generateTaskId('full');
    expect(id).toMatch(/^task_[a-f0-9]{32}$/);
  });
});
