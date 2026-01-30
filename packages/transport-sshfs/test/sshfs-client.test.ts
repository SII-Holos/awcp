/**
 * SSHFS Client Tests
 *
 * Unit tests for SSHFS mount client functionality.
 * These tests don't require actual sshfs - they test the logic around
 * credential file handling and argument building.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdir, rm, readFile, access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SshfsMountClient,
  buildSshfsArgs,
  type MountParams,
} from '../src/executor/sshfs-client.js';

describe('SshfsMountClient', () => {
  let testDir: string;
  let client: SshfsMountClient;

  const mockCredential = {
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-private-key\n-----END OPENSSH PRIVATE KEY-----',
    certificate: 'ssh-ed25519-cert-v01@openssh.com test-certificate',
  };

  const mockParams: MountParams = {
    endpoint: {
      host: 'test-host.example.com',
      port: 2222,
      user: 'testuser',
    },
    exportLocator: '/exports/workspace',
    credential: mockCredential,
    mountPoint: '/mnt/test',
  };

  beforeAll(async () => {
    testDir = join(tmpdir(), `awcp-sshfs-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    // Clean up any files created during tests
    const files = await import('node:fs/promises').then(fs => 
      fs.readdir(testDir).catch(() => [])
    );
    for (const file of files) {
      await rm(join(testDir, file), { force: true }).catch(() => {});
    }
  });

  describe('buildSshfsArgs', () => {
    it('should build correct sshfs arguments with credential paths', () => {
      const keyPath = '/tmp/mount-123';
      const certPath = '/tmp/mount-123-cert.pub';

      const args = buildSshfsArgs(mockParams, keyPath, certPath);

      expect(args).toContain('testuser@test-host.example.com:/exports/workspace');
      expect(args).toContain('/mnt/test');
      expect(args).toContain(`IdentityFile=${keyPath}`);
      expect(args).toContain(`CertificateFile=${certPath}`);
      expect(args).toContain('Port=2222');
      expect(args).toContain('StrictHostKeyChecking=no');
      expect(args).toContain('UserKnownHostsFile=/dev/null');
    });

    it('should include custom options', () => {
      const keyPath = '/tmp/mount-123';
      const certPath = '/tmp/mount-123-cert.pub';
      const paramsWithOptions: MountParams = {
        ...mockParams,
        options: { cache: 'yes', compression: 'no' },
      };

      const args = buildSshfsArgs(paramsWithOptions, keyPath, certPath);

      expect(args).toContain('cache=yes');
      expect(args).toContain('compression=no');
    });

    it('should merge default options with params options', () => {
      const keyPath = '/tmp/mount-123';
      const certPath = '/tmp/mount-123-cert.pub';
      const defaultOptions = { default_permissions: 'yes' };
      const paramsWithOptions: MountParams = {
        ...mockParams,
        options: { cache: 'yes' },
      };

      const args = buildSshfsArgs(paramsWithOptions, keyPath, certPath, defaultOptions);

      expect(args).toContain('default_permissions=yes');
      expect(args).toContain('cache=yes');
    });
  });

  describe('writeCredentialFiles', () => {
    it('should write private key and certificate to separate files', async () => {
      client = new SshfsMountClient({ tempKeyDir: testDir });

      const { keyPath, certPath } = await client.writeCredentialFiles(testDir, mockCredential);

      // Verify private key file
      const privateKeyContent = await readFile(keyPath, 'utf-8');
      expect(privateKeyContent).toBe(mockCredential.privateKey);

      // Verify certificate file
      const certContent = await readFile(certPath, 'utf-8');
      expect(certContent).toBe(mockCredential.certificate);

      // Verify certificate path follows SSH convention
      expect(certPath).toBe(`${keyPath}-cert.pub`);
    });

    it('should set correct file permissions', async () => {
      client = new SshfsMountClient({ tempKeyDir: testDir });

      const { keyPath, certPath } = await client.writeCredentialFiles(testDir, mockCredential);

      // Private key should be 0600 (readable/writable by owner only)
      const keyStats = await stat(keyPath);
      expect(keyStats.mode & 0o777).toBe(0o600);

      // Certificate can be more permissive (0644)
      const certStats = await stat(certPath);
      expect(certStats.mode & 0o777).toBe(0o644);
    });

    it('should create temp directory if it does not exist', async () => {
      const nestedDir = join(testDir, 'nested', 'dir');
      client = new SshfsMountClient({ tempKeyDir: nestedDir });

      await client.writeCredentialFiles(nestedDir, mockCredential);

      await expect(access(nestedDir)).resolves.not.toThrow();
    });
  });

  describe('cleanupCredentialFiles', () => {
    it('should delete both key and certificate files', async () => {
      client = new SshfsMountClient({ tempKeyDir: testDir });

      // First create the files
      const { keyPath, certPath } = await client.writeCredentialFiles(testDir, mockCredential);

      // Verify they exist
      await expect(access(keyPath)).resolves.not.toThrow();
      await expect(access(certPath)).resolves.not.toThrow();

      // Clean up
      await client.cleanupCredentialFiles(keyPath, certPath);

      // Verify they're gone
      await expect(access(keyPath)).rejects.toThrow();
      await expect(access(certPath)).rejects.toThrow();
    });

    it('should not throw if files do not exist', async () => {
      client = new SshfsMountClient({ tempKeyDir: testDir });

      await expect(
        client.cleanupCredentialFiles('/nonexistent/key', '/nonexistent/cert')
      ).resolves.not.toThrow();
    });
  });

  describe('checkDependency', () => {
    it('should return available status based on sshfs presence', async () => {
      client = new SshfsMountClient();

      const result = await client.checkDependency();

      // Result depends on whether sshfs is installed in the test environment
      expect(result).toHaveProperty('available');
      if (result.available) {
        expect(result.version).toBeDefined();
      } else {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('active mount tracking', () => {
    it('should track mounts correctly', async () => {
      client = new SshfsMountClient({ tempKeyDir: testDir });

      // Manually add to active mounts (simulating successful mount)
      const mounts = client.getActiveMounts();
      mounts.set('/mnt/test1', {
        mountPoint: '/mnt/test1',
        keyPath: join(testDir, 'key1'),
        certPath: join(testDir, 'key1-cert.pub'),
      });

      expect(client.getActiveMounts().has('/mnt/test1')).toBe(true);
      expect(client.getActiveMounts().size).toBe(1);
    });
  });
});
