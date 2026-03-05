/**
 * Multi-Round Integration Tests
 *
 * Tests that detach() is a no-op (state preserved between rounds) while
 * release() performs final cleanup for both delegator and executor transports.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { SshfsDelegatorTransport } from '../src/delegator/transport.js';
import { SshfsExecutorTransport } from '../src/executor/transport.js';

describe('Multi-round: SshfsDelegatorTransport', () => {
  let testDir: string;
  let keyDir: string;
  let caKeyPath: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `awcp-multi-round-delegator-${Date.now()}`);
    keyDir = join(testDir, 'keys');
    caKeyPath = join(testDir, 'ca');

    await mkdir(keyDir, { recursive: true });

    execSync(`ssh-keygen -t ed25519 -f "${caKeyPath}" -N "" -C "test-ca"`, {
      stdio: 'ignore',
    });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('detach should not revoke credentials', async () => {
    const transport = new SshfsDelegatorTransport({
      caKeyPath,
      keyDir,
      host: 'localhost',
      port: 22,
      user: 'testuser',
    });

    const delegationId = `detach-test-${Date.now()}`;
    await transport.prepare({
      delegationId,
      exportPath: '/export/workspace',
      ttlSeconds: 3600,
    });

    const privateKeyPath = join(keyDir, delegationId);
    const publicKeyPath = join(keyDir, `${delegationId}.pub`);
    const certPath = join(keyDir, `${delegationId}-cert.pub`);

    await expect(access(privateKeyPath)).resolves.not.toThrow();
    await expect(access(certPath)).resolves.not.toThrow();

    await transport.detach(delegationId);

    await expect(access(privateKeyPath)).resolves.not.toThrow();
    await expect(access(publicKeyPath)).resolves.not.toThrow();
    await expect(access(certPath)).resolves.not.toThrow();
  });

  it('release should revoke credentials', async () => {
    const transport = new SshfsDelegatorTransport({
      caKeyPath,
      keyDir,
      host: 'localhost',
      port: 22,
      user: 'testuser',
    });

    const delegationId = `release-test-${Date.now()}`;
    await transport.prepare({
      delegationId,
      exportPath: '/export/workspace',
      ttlSeconds: 3600,
    });

    const privateKeyPath = join(keyDir, delegationId);
    const publicKeyPath = join(keyDir, `${delegationId}.pub`);
    const certPath = join(keyDir, `${delegationId}-cert.pub`);

    await expect(access(privateKeyPath)).resolves.not.toThrow();

    await transport.release(delegationId);

    await expect(access(privateKeyPath)).rejects.toThrow();
    await expect(access(publicKeyPath)).rejects.toThrow();
    await expect(access(certPath)).rejects.toThrow();
  });

  it('credentials survive detach but are cleaned up by release', async () => {
    const transport = new SshfsDelegatorTransport({
      caKeyPath,
      keyDir,
      host: 'localhost',
      port: 22,
      user: 'testuser',
    });

    const delegationId = `full-cycle-${Date.now()}`;
    await transport.prepare({
      delegationId,
      exportPath: '/export/workspace',
      ttlSeconds: 3600,
    });

    const privateKeyPath = join(keyDir, delegationId);
    const certPath = join(keyDir, `${delegationId}-cert.pub`);

    await transport.detach(delegationId);
    await transport.detach(delegationId);
    await transport.detach(delegationId);

    await expect(access(privateKeyPath)).resolves.not.toThrow();
    await expect(access(certPath)).resolves.not.toThrow();

    await transport.release(delegationId);

    await expect(access(privateKeyPath)).rejects.toThrow();
    await expect(access(certPath)).rejects.toThrow();
  });
});

describe('Multi-round: SshfsExecutorTransport', () => {
  let testDir: string;
  let transport: SshfsExecutorTransport;

  beforeAll(async () => {
    testDir = join(tmpdir(), `awcp-multi-round-executor-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    transport = new SshfsExecutorTransport({ tempKeyDir: testDir });
  });

  it('detach should be a no-op (not unmount)', async () => {
    const mountClient = (transport as any).mountClient;
    const mounts = mountClient.getActiveMounts();

    mounts.set('/mnt/round-test', {
      mountPoint: '/mnt/round-test',
      keyPath: join(testDir, 'key1'),
      certPath: join(testDir, 'key1-cert.pub'),
    });

    expect(mounts.size).toBe(1);

    await transport.detach({ delegationId: 'test-1', localPath: '/mnt/round-test' });

    expect(mounts.size).toBe(1);
    expect(mounts.has('/mnt/round-test')).toBe(true);
  });

  it('release should remove mount tracking entry', async () => {
    const mountClient = (transport as any).mountClient;
    const mounts = mountClient.getActiveMounts();

    mounts.set('/mnt/release-test', {
      mountPoint: '/mnt/release-test',
      keyPath: join(testDir, 'key2'),
      certPath: join(testDir, 'key2-cert.pub'),
    });

    expect(mounts.has('/mnt/release-test')).toBe(true);

    await transport.release({ delegationId: 'test-2', localPath: '/mnt/release-test' });

    expect(mounts.has('/mnt/release-test')).toBe(false);
  });

  it('mount tracking survives multiple detach calls', async () => {
    const mountClient = (transport as any).mountClient;
    const mounts = mountClient.getActiveMounts();

    mounts.set('/mnt/multi-detach', {
      mountPoint: '/mnt/multi-detach',
      keyPath: join(testDir, 'key3'),
      certPath: join(testDir, 'key3-cert.pub'),
    });

    await transport.detach({ delegationId: 'test-3', localPath: '/mnt/multi-detach' });
    await transport.detach({ delegationId: 'test-3', localPath: '/mnt/multi-detach' });
    await transport.detach({ delegationId: 'test-3', localPath: '/mnt/multi-detach' });

    expect(mounts.size).toBe(1);
    expect(mounts.get('/mnt/multi-detach')?.mountPoint).toBe('/mnt/multi-detach');
  });
});
