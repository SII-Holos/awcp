/**
 * Credential Manager Tests
 * 
 * Tests for SSH key generation and management.
 * Note: Some tests require actual ssh-keygen which may not be available in all CI environments.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CredentialManager } from '../src/delegator/credential-manager.js';

describe('CredentialManager', () => {
  let testKeyDir: string;
  let testAuthorizedKeysPath: string;
  let manager: CredentialManager;

  beforeEach(async () => {
    // Create temp directories for testing
    const testDir = join(tmpdir(), `awcp-cred-test-${Date.now()}`);
    testKeyDir = join(testDir, 'keys');
    testAuthorizedKeysPath = join(testDir, 'authorized_keys');
    
    await mkdir(testKeyDir, { recursive: true });
    await writeFile(testAuthorizedKeysPath, '# Test authorized_keys\n');

    manager = new CredentialManager({
      keyDir: testKeyDir,
      authorizedKeysPath: testAuthorizedKeysPath,
      sshHost: 'localhost',
      sshPort: 22,
      sshUser: 'testuser',
    });
  });

  afterEach(async () => {
    // Clean up
    const testDir = join(testKeyDir, '..');
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('generateCredential', () => {
    it('should generate a credential with SSH key', async () => {
      const delegationId = 'test-delegation-123';
      
      const result = await manager.generateCredential(delegationId, 3600);
      
      expect(result.credential).toBeDefined();
      expect(result.credential).toContain('PRIVATE KEY');
      expect(result.endpoint.host).toBe('localhost');
      expect(result.endpoint.port).toBe(22);
      expect(result.endpoint.user).toBe('testuser');
    });

    it('should add public key to authorized_keys', async () => {
      const delegationId = 'test-delegation-456';
      
      await manager.generateCredential(delegationId, 3600);
      
      const authorizedKeys = await readFile(testAuthorizedKeysPath, 'utf-8');
      expect(authorizedKeys).toContain(`awcp-temp-key-${delegationId}`);
      expect(authorizedKeys).toContain('ssh-ed25519');
    });

    it('should track active credentials', async () => {
      const delegationId = 'test-delegation-789';
      
      await manager.generateCredential(delegationId, 3600);
      
      const credential = manager.getCredential(delegationId);
      expect(credential).toBeDefined();
      expect(credential?.delegationId).toBe(delegationId);
    });
  });

  describe('revokeCredential', () => {
    it('should remove credential from tracking', async () => {
      const delegationId = 'test-revoke-123';
      
      await manager.generateCredential(delegationId, 3600);
      expect(manager.getCredential(delegationId)).toBeDefined();
      
      await manager.revokeCredential(delegationId);
      expect(manager.getCredential(delegationId)).toBeUndefined();
    });

    it('should remove public key from authorized_keys', async () => {
      const delegationId = 'test-revoke-456';
      
      await manager.generateCredential(delegationId, 3600);
      let authorizedKeys = await readFile(testAuthorizedKeysPath, 'utf-8');
      expect(authorizedKeys).toContain(`awcp-temp-key-${delegationId}`);
      
      await manager.revokeCredential(delegationId);
      authorizedKeys = await readFile(testAuthorizedKeysPath, 'utf-8');
      expect(authorizedKeys).not.toContain(`awcp-temp-key-${delegationId}`);
    });

    it('should handle revoking non-existent credential gracefully', async () => {
      await expect(manager.revokeCredential('non-existent')).resolves.not.toThrow();
    });
  });

  describe('cleanupStaleKeys', () => {
    it('should remove all AWCP keys from authorized_keys', async () => {
      // Add some AWCP keys
      await manager.generateCredential('stale-1', 3600);
      await manager.generateCredential('stale-2', 3600);
      
      // Simulate restart by creating new manager
      const newManager = new CredentialManager({
        keyDir: testKeyDir,
        authorizedKeysPath: testAuthorizedKeysPath,
      });
      
      const removedCount = await newManager.cleanupStaleKeys();
      
      expect(removedCount).toBe(2);
      const authorizedKeys = await readFile(testAuthorizedKeysPath, 'utf-8');
      expect(authorizedKeys).not.toContain('awcp-temp-key');
    });

    it('should not remove non-AWCP keys', async () => {
      // Add a regular SSH key
      const regularKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIxxxxxx user@host\n';
      await writeFile(testAuthorizedKeysPath, regularKey);
      
      await manager.generateCredential('test-1', 3600);
      
      const newManager = new CredentialManager({
        keyDir: testKeyDir,
        authorizedKeysPath: testAuthorizedKeysPath,
      });
      
      await newManager.cleanupStaleKeys();
      
      const authorizedKeys = await readFile(testAuthorizedKeysPath, 'utf-8');
      expect(authorizedKeys).toContain('user@host');
    });
  });

  describe('revokeAll', () => {
    it('should revoke all active credentials', async () => {
      await manager.generateCredential('multi-1', 3600);
      await manager.generateCredential('multi-2', 3600);
      await manager.generateCredential('multi-3', 3600);
      
      await manager.revokeAll();
      
      expect(manager.getCredential('multi-1')).toBeUndefined();
      expect(manager.getCredential('multi-2')).toBeUndefined();
      expect(manager.getCredential('multi-3')).toBeUndefined();
    });
  });
});
