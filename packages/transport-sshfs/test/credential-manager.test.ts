/**
 * Credential Manager Tests
 *
 * Tests for SSH certificate generation and management.
 * Note: Tests require ssh-keygen which may not be available in all CI environments.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdir, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { CredentialManager } from '../src/delegator/credential-manager.js';

describe('CredentialManager', () => {
  let testDir: string;
  let testKeyDir: string;
  let testCaKeyPath: string;
  let manager: CredentialManager;

  beforeAll(async () => {
    // Create temp directories for testing
    testDir = join(tmpdir(), `awcp-cred-test-${Date.now()}`);
    testKeyDir = join(testDir, 'keys');
    testCaKeyPath = join(testDir, 'ca');

    await mkdir(testKeyDir, { recursive: true });

    // Generate test CA key pair
    execSync(`ssh-keygen -t ed25519 -f "${testCaKeyPath}" -N "" -C "test-ca"`, {
      stdio: 'ignore',
    });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    manager = new CredentialManager({
      keyDir: testKeyDir,
      caKeyPath: testCaKeyPath,
      sshHost: 'localhost',
      sshPort: 22,
      sshUser: 'testuser',
    });
  });

  describe('generateCredential', () => {
    it('should generate a credential with SSH key and certificate', async () => {
      const delegationId = 'test-delegation-123';

      const result = await manager.generateCredential(delegationId, 3600);

      expect(result.credential).toBeDefined();
      expect(result.credential.privateKey).toContain('PRIVATE KEY');
      expect(result.credential.certificate).toContain('ssh-ed25519-cert-v01@openssh.com');
      expect(result.endpoint.host).toBe('localhost');
      expect(result.endpoint.port).toBe(22);
      expect(result.endpoint.user).toBe('testuser');
    });

    it('should create certificate file', async () => {
      const delegationId = 'test-delegation-456';

      await manager.generateCredential(delegationId, 3600);

      const certPath = join(testKeyDir, `${delegationId}-cert.pub`);
      await expect(access(certPath)).resolves.not.toThrow();

      const certContent = await readFile(certPath, 'utf-8');
      expect(certContent).toContain('ssh-ed25519-cert-v01@openssh.com');
    });

    it('should track active credentials', async () => {
      const delegationId = 'test-delegation-789';

      await manager.generateCredential(delegationId, 3600);

      const credential = manager.getCredential(delegationId);
      expect(credential).toBeDefined();
      expect(credential?.delegationId).toBe(delegationId);
      expect(credential?.certPath).toContain(`${delegationId}-cert.pub`);
    });

    it('should use TTL for certificate validity', async () => {
      const delegationId = 'test-delegation-ttl';
      const ttlSeconds = 60; // 1 minute

      await manager.generateCredential(delegationId, ttlSeconds);

      // Verify certificate was created (TTL is embedded in certificate)
      const certPath = join(testKeyDir, `${delegationId}-cert.pub`);
      const certContent = await readFile(certPath, 'utf-8');
      expect(certContent).toBeDefined();
    });
  });

  describe('loadAll', () => {
    it('should restore credentials from key files on disk', async () => {
      await manager.generateCredential('load-1', 3600);
      await manager.generateCredential('load-2', 3600);

      const freshManager = new CredentialManager({
        keyDir: testKeyDir,
        caKeyPath: testCaKeyPath,
      });

      expect(freshManager.getCredential('load-1')).toBeUndefined();
      expect(freshManager.getCredential('load-2')).toBeUndefined();

      await freshManager.loadAll();

      expect(freshManager.getCredential('load-1')).toBeDefined();
      expect(freshManager.getCredential('load-1')?.delegationId).toBe('load-1');
      expect(freshManager.getCredential('load-2')).toBeDefined();
    });

    it('should skip entries without certificate file', async () => {
      const freshManager = new CredentialManager({
        keyDir: testKeyDir,
        caKeyPath: testCaKeyPath,
      });

      await freshManager.loadAll();

      expect(freshManager.getCredential(testCaKeyPath.split('/').pop()!)).toBeUndefined();
    });

    it('should handle non-existent keyDir gracefully', async () => {
      const freshManager = new CredentialManager({
        keyDir: '/non/existent/dir',
        caKeyPath: testCaKeyPath,
      });

      await expect(freshManager.loadAll()).resolves.not.toThrow();
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

    it('should delete key and certificate files', async () => {
      const delegationId = 'test-revoke-456';

      await manager.generateCredential(delegationId, 3600);

      const privateKeyPath = join(testKeyDir, delegationId);
      const publicKeyPath = join(testKeyDir, `${delegationId}.pub`);
      const certPath = join(testKeyDir, `${delegationId}-cert.pub`);

      // Files should exist
      await expect(access(privateKeyPath)).resolves.not.toThrow();
      await expect(access(publicKeyPath)).resolves.not.toThrow();
      await expect(access(certPath)).resolves.not.toThrow();

      await manager.revokeCredential(delegationId);

      // Files should be deleted
      await expect(access(privateKeyPath)).rejects.toThrow();
      await expect(access(publicKeyPath)).rejects.toThrow();
      await expect(access(certPath)).rejects.toThrow();
    });

    it('should handle revoking non-existent credential gracefully', async () => {
      await expect(manager.revokeCredential('non-existent')).resolves.not.toThrow();
    });
  });

  describe('cleanupStaleKeyFiles', () => {
    it('should remove stale key files not in active credentials', async () => {
      // Generate some credentials
      await manager.generateCredential('stale-1', 3600);
      await manager.generateCredential('stale-2', 3600);

      // Simulate restart by creating new manager (no active credentials)
      const newManager = new CredentialManager({
        keyDir: testKeyDir,
        caKeyPath: testCaKeyPath,
      });

      const removedCount = await newManager.cleanupStaleKeyFiles();

      // Should remove private key, public key, and cert for each delegation
      expect(removedCount).toBeGreaterThan(0);
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

  describe('CA key auto-generation', () => {
    it('should auto-generate CA key if not present', async () => {
      const autoCaDir = join(testDir, 'auto-ca');
      const autoCaKeyPath = join(autoCaDir, 'ca');
      const autoKeyDir = join(testDir, 'auto-keys');

      const autoManager = new CredentialManager({
        keyDir: autoKeyDir,
        caKeyPath: autoCaKeyPath,
        sshHost: 'localhost',
        sshPort: 22,
        sshUser: 'testuser',
      });

      // CA key should not exist yet
      await expect(access(autoCaKeyPath)).rejects.toThrow();

      // Generate credential - this should auto-generate CA key
      const result = await autoManager.generateCredential('auto-test', 3600);

      // CA key should now exist
      await expect(access(autoCaKeyPath)).resolves.not.toThrow();
      await expect(access(`${autoCaKeyPath}.pub`)).resolves.not.toThrow();

      // Credential should be valid
      expect(result.credential.privateKey).toContain('PRIVATE KEY');
      expect(result.credential.certificate).toContain('ssh-ed25519-cert-v01@openssh.com');
    });
  });
});
