/**
 * Delegator Config Tests
 * 
 * Tests for configuration resolution and default values.
 */

import { describe, it, expect } from 'vitest';
import { resolveDelegatorConfig, DEFAULT_ADMISSION, DEFAULT_DELEGATION } from '../../src/delegator/config.js';
import type { DelegatorConfig } from '../../src/delegator/config.js';
import type { DelegatorTransportAdapter, SshfsTransportHandle } from '@awcp/core';

const mockTransport: DelegatorTransportAdapter = {
  type: 'sshfs',
  capabilities: {
    supportsSnapshots: false,
    liveSync: true,
  },
  prepare: async () => ({
    transport: 'sshfs',
    endpoint: { host: 'localhost', port: 22, user: 'test' },
    exportLocator: '/tmp/test',
    credential: { privateKey: '', certificate: '' },
  }) as SshfsTransportHandle,
  detach: async () => {},
  release: async () => {},
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

    it('should apply default lease config', () => {
      const resolved = resolveDelegatorConfig(minimalConfig);
      expect(resolved.delegation.lease.ttlSeconds).toBe(3600);
      expect(resolved.delegation.lease.accessMode).toBe('rw');
    });

    it('should apply default snapshot config', () => {
      const resolved = resolveDelegatorConfig(minimalConfig);
      expect(resolved.delegation.snapshot.mode).toBe('auto');
      expect(resolved.delegation.snapshot.maxSnapshots).toBe(10);
    });

    it('should apply default retention config', () => {
      const resolved = resolveDelegatorConfig(minimalConfig);
      expect(resolved.delegation.retentionMs).toBe(DEFAULT_DELEGATION.retentionMs);
    });

    it('should default cleanupOnInitialize to true', () => {
      const resolved = resolveDelegatorConfig(minimalConfig);
      expect(resolved.cleanupOnInitialize).toBe(true);
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

    it('should preserve custom lease config', () => {
      const config: DelegatorConfig = {
        ...minimalConfig,
        delegation: {
          lease: {
            ttlSeconds: 7200,
            accessMode: 'ro',
          },
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.delegation.lease.ttlSeconds).toBe(7200);
      expect(resolved.delegation.lease.accessMode).toBe('ro');
    });

    it('should preserve custom snapshot config', () => {
      const config: DelegatorConfig = {
        ...minimalConfig,
        delegation: {
          snapshot: {
            mode: 'staged',
            maxSnapshots: 5,
          },
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.delegation.snapshot.mode).toBe('staged');
      expect(resolved.delegation.snapshot.maxSnapshots).toBe(5);
    });

    it('should preserve custom retention config', () => {
      const config: DelegatorConfig = {
        ...minimalConfig,
        delegation: {
          retentionMs: 30 * 24 * 60 * 60 * 1000,
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.delegation.retentionMs).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it('should allow disabling cleanupOnInitialize', () => {
      const config: DelegatorConfig = {
        ...minimalConfig,
        cleanupOnInitialize: false,
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.cleanupOnInitialize).toBe(false);
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

    it('should merge partial lease config with defaults', () => {
      const config: DelegatorConfig = {
        ...minimalConfig,
        delegation: {
          lease: { ttlSeconds: 1800 },
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.delegation.lease.ttlSeconds).toBe(1800);
      expect(resolved.delegation.lease.accessMode).toBe('rw');
    });

    it('should merge partial snapshot config with defaults', () => {
      const config: DelegatorConfig = {
        ...minimalConfig,
        delegation: {
          snapshot: { mode: 'staged' },
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.delegation.snapshot.mode).toBe('staged');
      expect(resolved.delegation.snapshot.maxSnapshots).toBe(DEFAULT_DELEGATION.snapshot.maxSnapshots);
    });

    it('should allow setting lease and snapshot independently', () => {
      const config: DelegatorConfig = {
        ...minimalConfig,
        delegation: {
          lease: { ttlSeconds: 1800 },
        },
      };

      const resolved = resolveDelegatorConfig(config);
      expect(resolved.delegation.lease.ttlSeconds).toBe(1800);
      expect(resolved.delegation.snapshot.mode).toBe('auto');
    });
  });
});

describe('DEFAULT constants', () => {
  it('should have sensible admission values', () => {
    expect(DEFAULT_ADMISSION.maxTotalBytes).toBe(100 * 1024 * 1024);
    expect(DEFAULT_ADMISSION.maxFileCount).toBe(10000);
    expect(DEFAULT_ADMISSION.maxSingleFileBytes).toBe(50 * 1024 * 1024);
  });

  it('should have sensible delegation defaults', () => {
    expect(DEFAULT_DELEGATION.retentionMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_DELEGATION.lease.ttlSeconds).toBe(3600);
    expect(DEFAULT_DELEGATION.lease.accessMode).toBe('rw');
    expect(DEFAULT_DELEGATION.snapshot.mode).toBe('auto');
    expect(DEFAULT_DELEGATION.snapshot.maxSnapshots).toBe(10);
  });
});
