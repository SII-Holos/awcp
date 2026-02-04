/**
 * Delegator Config Tests
 * 
 * Tests for configuration resolution and default values.
 */

import { describe, it, expect } from 'vitest';
import { resolveDelegatorConfig, DEFAULT_ADMISSION, DEFAULT_DELEGATION, DEFAULT_SNAPSHOT } from '../../src/delegator/config.js';
import type { DelegatorConfig } from '../../src/delegator/config.js';
import type { DelegatorTransportAdapter, SshfsWorkDirInfo } from '@awcp/core';

const mockTransport: DelegatorTransportAdapter = {
  type: 'sshfs',
  capabilities: {
    supportsSnapshots: false,
    liveSync: true,
  },
  prepare: async () => ({
    workDirInfo: {
      transport: 'sshfs',
      endpoint: { host: 'localhost', port: 22, user: 'test' },
      exportLocator: '/tmp/test',
      credential: { privateKey: '', certificate: '' },
    } as SshfsWorkDirInfo,
  }),
  cleanup: async () => {},
};

describe('resolveDelegatorConfig', () => {
  const minimalConfig: DelegatorConfig = {
    baseDir: '/custom/delegations',
    transport: mockTransport,
  };

  describe('default values', () => {
    it('should preserve baseDir', () => {
      const resolved = resolveDelegatorConfig(minimalConfig);
      expect(resolved.baseDir).toBe('/custom/delegations');
    });

    it('should apply default admission limits', () => {
      const resolved = resolveDelegatorConfig(minimalConfig);
      expect(resolved.admission.maxTotalBytes).toBe(DEFAULT_ADMISSION.maxTotalBytes);
      expect(resolved.admission.maxFileCount).toBe(DEFAULT_ADMISSION.maxFileCount);
      expect(resolved.admission.maxSingleFileBytes).toBe(DEFAULT_ADMISSION.maxSingleFileBytes);
    });

    it('should apply default snapshot policy', () => {
      const resolved = resolveDelegatorConfig(minimalConfig);
      expect(resolved.snapshot.mode).toBe(DEFAULT_SNAPSHOT.mode);
      expect(resolved.snapshot.retentionMs).toBe(DEFAULT_SNAPSHOT.retentionMs);
      expect(resolved.snapshot.maxSnapshots).toBe(DEFAULT_SNAPSHOT.maxSnapshots);
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
          maxTotalBytes: 50 * 1024 * 1024,
          maxFileCount: 500,
          maxSingleFileBytes: 10 * 1024 * 1024,
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.admission.maxTotalBytes).toBe(50 * 1024 * 1024);
      expect(resolved.admission.maxFileCount).toBe(500);
      expect(resolved.admission.maxSingleFileBytes).toBe(10 * 1024 * 1024);
    });

    it('should preserve custom snapshot policy', () => {
      const config: DelegatorConfig = {
        ...minimalConfig,
        snapshot: {
          mode: 'staged',
          retentionMs: 60 * 60 * 1000,
          maxSnapshots: 5,
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.snapshot.mode).toBe('staged');
      expect(resolved.snapshot.retentionMs).toBe(60 * 60 * 1000);
      expect(resolved.snapshot.maxSnapshots).toBe(5);
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
          maxFileCount: 100,
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.admission.maxFileCount).toBe(100);
      expect(resolved.admission.maxTotalBytes).toBe(DEFAULT_ADMISSION.maxTotalBytes);
      expect(resolved.admission.maxSingleFileBytes).toBe(DEFAULT_ADMISSION.maxSingleFileBytes);
    });

    it('should merge partial snapshot config with defaults', () => {
      const config: DelegatorConfig = {
        ...minimalConfig,
        snapshot: {
          mode: 'staged',
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.snapshot.mode).toBe('staged');
      expect(resolved.snapshot.retentionMs).toBe(DEFAULT_SNAPSHOT.retentionMs);
      expect(resolved.snapshot.maxSnapshots).toBe(DEFAULT_SNAPSHOT.maxSnapshots);
    });

    it('should merge partial defaults with defaults', () => {
      const config: DelegatorConfig = {
        ...minimalConfig,
        defaults: {
          ttlSeconds: 1800,
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.defaults.ttlSeconds).toBe(1800);
      expect(resolved.defaults.accessMode).toBe('rw');
    });
  });
});

describe('DEFAULT constants', () => {
  it('should have sensible admission values', () => {
    expect(DEFAULT_ADMISSION.maxTotalBytes).toBe(100 * 1024 * 1024);
    expect(DEFAULT_ADMISSION.maxFileCount).toBe(10000);
    expect(DEFAULT_ADMISSION.maxSingleFileBytes).toBe(50 * 1024 * 1024);
  });

  it('should have sensible snapshot values', () => {
    expect(DEFAULT_SNAPSHOT.mode).toBe('auto');
    expect(DEFAULT_SNAPSHOT.retentionMs).toBe(30 * 60 * 1000);
    expect(DEFAULT_SNAPSHOT.maxSnapshots).toBe(10);
  });

  it('should have sensible delegation defaults', () => {
    expect(DEFAULT_DELEGATION.ttlSeconds).toBe(3600);
    expect(DEFAULT_DELEGATION.accessMode).toBe('rw');
  });
});
