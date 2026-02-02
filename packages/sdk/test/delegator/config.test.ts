/**
 * Delegator Config Tests
 * 
 * Tests for configuration resolution and default values.
 */

import { describe, it, expect } from 'vitest';
import { resolveDelegatorConfig, DEFAULT_DELEGATOR_CONFIG } from '../../src/delegator/config.js';
import type { DelegatorConfig } from '../../src/delegator/config.js';
import type { DelegatorTransportAdapter } from '@awcp/core';

// Mock transport adapter
const mockTransport: DelegatorTransportAdapter = {
  type: 'sshfs',
  prepare: async () => ({ workDirInfo: { transport: 'sshfs' } }),
  cleanup: async () => {},
};

describe('resolveDelegatorConfig', () => {
  const minimalConfig: DelegatorConfig = {
    environment: {
      baseDir: '/custom/environments',
    },
    transport: mockTransport,
  };

  describe('default values', () => {
    it('should preserve environment baseDir', () => {
      const resolved = resolveDelegatorConfig(minimalConfig);
      expect(resolved.export.baseDir).toBe('/custom/environments');
    });

    it('should apply default admission limits', () => {
      const resolved = resolveDelegatorConfig(minimalConfig);
      expect(resolved.admission.maxTotalBytes).toBe(DEFAULT_DELEGATOR_CONFIG.admission.maxTotalBytes);
      expect(resolved.admission.maxFileCount).toBe(DEFAULT_DELEGATOR_CONFIG.admission.maxFileCount);
      expect(resolved.admission.maxSingleFileBytes).toBe(DEFAULT_DELEGATOR_CONFIG.admission.maxSingleFileBytes);
    });

    it('should apply default TTL and access mode', () => {
      const resolved = resolveDelegatorConfig(minimalConfig);
      expect(resolved.defaults.ttlSeconds).toBe(3600);
      expect(resolved.defaults.accessMode).toBe('rw');
    });

    it('should preserve transport adapter', () => {
      const resolved = resolveDelegatorConfig(minimalConfig);
      expect(resolved.transport).toBe(mockTransport);
    });
  });

  describe('custom values', () => {
    it('should preserve custom admission limits', () => {
      const config: DelegatorConfig = {
        ...minimalConfig,
        admission: {
          maxTotalBytes: 50 * 1024 * 1024, // 50MB
          maxFileCount: 500,
          maxSingleFileBytes: 10 * 1024 * 1024, // 10MB
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.admission.maxTotalBytes).toBe(50 * 1024 * 1024);
      expect(resolved.admission.maxFileCount).toBe(500);
      expect(resolved.admission.maxSingleFileBytes).toBe(10 * 1024 * 1024);
    });

    it('should preserve custom defaults', () => {
      const config: DelegatorConfig = {
        ...minimalConfig,
        defaults: {
          ttlSeconds: 7200,
          accessMode: 'ro',
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.defaults.ttlSeconds).toBe(7200);
      expect(resolved.defaults.accessMode).toBe('ro');
    });

    it('should preserve hooks', () => {
      const onCreated = () => {};
      const onCompleted = () => {};
      
      const config: DelegatorConfig = {
        ...minimalConfig,
        hooks: {
          onDelegationCreated: onCreated,
          onDelegationCompleted: onCompleted,
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.hooks.onDelegationCreated).toBe(onCreated);
      expect(resolved.hooks.onDelegationCompleted).toBe(onCompleted);
    });
  });

  describe('partial overrides', () => {
    it('should merge partial admission config with defaults', () => {
      const config: DelegatorConfig = {
        ...minimalConfig,
        admission: {
          maxFileCount: 100, // Only override this one
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.admission.maxFileCount).toBe(100);
      expect(resolved.admission.maxTotalBytes).toBe(DEFAULT_DELEGATOR_CONFIG.admission.maxTotalBytes);
      expect(resolved.admission.maxSingleFileBytes).toBe(DEFAULT_DELEGATOR_CONFIG.admission.maxSingleFileBytes);
    });

    it('should merge partial defaults with defaults', () => {
      const config: DelegatorConfig = {
        ...minimalConfig,
        defaults: {
          ttlSeconds: 1800, // Only override TTL
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.defaults.ttlSeconds).toBe(1800);
      expect(resolved.defaults.accessMode).toBe('rw'); // Default
    });
  });
});

describe('DEFAULT_DELEGATOR_CONFIG', () => {
  it('should have sensible default values', () => {
    expect(DEFAULT_DELEGATOR_CONFIG.admission.maxTotalBytes).toBe(100 * 1024 * 1024); // 100MB
    expect(DEFAULT_DELEGATOR_CONFIG.admission.maxFileCount).toBe(10000);
    expect(DEFAULT_DELEGATOR_CONFIG.admission.maxSingleFileBytes).toBe(50 * 1024 * 1024); // 50MB
    expect(DEFAULT_DELEGATOR_CONFIG.defaults.ttlSeconds).toBe(3600);
    expect(DEFAULT_DELEGATOR_CONFIG.defaults.accessMode).toBe('rw');
  });
});
