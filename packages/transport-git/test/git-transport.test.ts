import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitDelegatorTransport } from '../src/delegator/transport.js';
import { GitExecutorTransport } from '../src/executor/transport.js';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

describe('GitDelegatorTransport', () => {
  describe('constructor', () => {
    it('should create instance with required config', () => {
      const transport = new GitDelegatorTransport({
        remoteUrl: 'https://github.com/test/repo.git',
        auth: { type: 'none' },
      });
      expect(transport.type).toBe('git');
      expect(transport.capabilities).toEqual({
        supportsSnapshots: true,
        liveSync: false,
      });
    });
  });

  describe('prepare', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'awcp-git-test-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('should throw error when export path does not exist', async () => {
      const transport = new GitDelegatorTransport({
        remoteUrl: 'https://github.com/test/repo.git',
        auth: { type: 'none' },
        tempDir,
      });
      await expect(
        transport.prepare({
          delegationId: 'test-dlg',
          exportPath: '/nonexistent/path',
          ttlSeconds: 3600,
        }),
      ).rejects.toThrow();
    });
  });

  describe('detach', () => {
    it('should be a no-op', async () => {
      const transport = new GitDelegatorTransport({
        remoteUrl: 'https://github.com/test/repo.git',
        auth: { type: 'none' },
      });
      await expect(transport.detach('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('release', () => {
    it('should handle nonexistent delegation gracefully', async () => {
      const transport = new GitDelegatorTransport({
        remoteUrl: 'https://github.com/test/repo.git',
        auth: { type: 'none' },
      });
      await expect(transport.release('nonexistent')).resolves.toBeUndefined();
    });
  });
});

describe('GitExecutorTransport', () => {
  describe('constructor', () => {
    it('should create instance with default config', () => {
      const transport = new GitExecutorTransport();
      expect(transport.type).toBe('git');
      expect(transport.capabilities).toEqual({
        supportsSnapshots: true,
        liveSync: false,
      });
    });

    it('should accept custom config', () => {
      const transport = new GitExecutorTransport({
        tempDir: '/custom/temp',
        branchPrefix: 'task/',
      });
      expect(transport.type).toBe('git');
    });
  });

  describe('checkDependency', () => {
    it('should return available true when git is installed', async () => {
      const transport = new GitExecutorTransport();
      const result = await transport.checkDependency();
      expect(result.available).toBe(true);
    });
  });

  describe('setup', () => {
    it('should reject non-git handle', async () => {
      const transport = new GitExecutorTransport();
      await expect(
        transport.setup({
          delegationId: 'test',
          handle: { transport: 'archive', archiveBase64: '', checksum: '' } as any,
          localPath: '/tmp/test',
        }),
      ).rejects.toThrow('unexpected transport type: archive');
    });
  });

  describe('captureSnapshot', () => {
    it('should throw when no active setup exists', async () => {
      const transport = new GitExecutorTransport();
      await expect(
        transport.captureSnapshot({
          delegationId: 'nonexistent',
          localPath: '/tmp/test',
        }),
      ).rejects.toThrow('no active setup for delegation nonexistent');
    });
  });

  describe('detach', () => {
    it('should handle missing delegation gracefully', async () => {
      const transport = new GitExecutorTransport();
      await expect(
        transport.detach({ delegationId: 'nonexistent', localPath: '/tmp/nonexistent' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('release', () => {
    it('should handle missing delegation gracefully', async () => {
      const transport = new GitExecutorTransport();
      await expect(
        transport.release({ delegationId: 'nonexistent', localPath: '/tmp/nonexistent' }),
      ).resolves.toBeUndefined();
    });
  });
});

describe('Multi-round integration', () => {
  let tempDir: string;
  let bareRepoPath: string;
  let delegator: GitDelegatorTransport;
  let executor: GitExecutorTransport;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'awcp-git-mr-'));
    bareRepoPath = join(tempDir, 'remote.git');

    execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepoPath]);

    delegator = new GitDelegatorTransport({
      remoteUrl: bareRepoPath,
      auth: { type: 'none' },
      tempDir: join(tempDir, 'delegator-tmp'),
    });

    executor = new GitExecutorTransport({
      tempDir: join(tempDir, 'executor-tmp'),
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createSourceWorkspace(content: string): Promise<string> {
    const srcDir = join(tempDir, 'source-workspace');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'file.txt'), content);

    execFileSync('git', ['init', '--initial-branch=main'], { cwd: srcDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: srcDir });
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: srcDir });
    execFileSync('git', ['add', '-A'], { cwd: srcDir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: srcDir });

    return srcDir;
  }

  async function prepareAndSetup(delegationId: string, initialContent: string) {
    const srcDir = await createSourceWorkspace(initialContent);
    const handle = await delegator.prepare({
      delegationId,
      exportPath: srcDir,
      ttlSeconds: 3600,
    });

    const localPath = join(tempDir, 'executor-work', delegationId);
    await mkdir(localPath, { recursive: true });

    await executor.setup({ delegationId, handle, localPath });
    return localPath;
  }

  it('should preserve activeSetups across detach for multi-round snapshots', async () => {
    const delegationId = 'mr-preserve';
    const localPath = await prepareAndSetup(delegationId, 'initial');

    await writeFile(join(localPath, 'file.txt'), 'round1');
    const round1 = await executor.captureSnapshot({ delegationId, localPath });
    const snap1 = JSON.parse(round1.snapshotBase64);
    expect(snap1.branch).toBeTruthy();
    expect(snap1.commitHash).toBeTruthy();

    await executor.detach({ delegationId, localPath });

    await writeFile(join(localPath, 'file.txt'), 'round2');
    const round2 = await executor.captureSnapshot({ delegationId, localPath });
    const snap2 = JSON.parse(round2.snapshotBase64);
    expect(snap2.branch).toBe(snap1.branch);
    expect(snap2.commitHash).toBeTruthy();
    expect(snap2.commitHash).not.toBe(snap1.commitHash);
  });

  it('should allow delegator to apply snapshots from different rounds', async () => {
    const delegationId = 'mr-apply';
    const localPath = await prepareAndSetup(delegationId, 'initial');

    await writeFile(join(localPath, 'file.txt'), 'round1');
    await executor.captureSnapshot({ delegationId, localPath });
    await executor.detach({ delegationId, localPath });

    await writeFile(join(localPath, 'file.txt'), 'round2-content');
    const round2 = await executor.captureSnapshot({ delegationId, localPath });
    const snap2 = JSON.parse(round2.snapshotBase64);

    await delegator.applySnapshot({
      delegationId,
      snapshotData: round2.snapshotBase64,
      resources: [],
    });

    const delegatorWorkDir = join(tempDir, 'delegator-tmp', delegationId);
    const content = await readFile(join(delegatorWorkDir, 'file.txt'), 'utf-8');
    expect(content).toBe('round2-content');
  });

  it('should fail captureSnapshot after release but succeed after detach', async () => {
    const delegationId = 'mr-release';
    const localPath = await prepareAndSetup(delegationId, 'initial');

    await writeFile(join(localPath, 'file.txt'), 'snap1');
    await executor.captureSnapshot({ delegationId, localPath });

    await executor.detach({ delegationId, localPath });

    await writeFile(join(localPath, 'file.txt'), 'snap2');
    await executor.captureSnapshot({ delegationId, localPath });

    await executor.release({ delegationId, localPath });

    await writeFile(join(localPath, 'file.txt'), 'snap3');
    await expect(
      executor.captureSnapshot({ delegationId, localPath }),
    ).rejects.toThrow(`no active setup for delegation ${delegationId}`);
  });

  it('should support full lifecycle: setup → round1 → detach → round2 → detach → release', async () => {
    const delegationId = 'mr-full';
    const localPath = await prepareAndSetup(delegationId, 'initial');

    await writeFile(join(localPath, 'file.txt'), 'v1');
    const round1 = await executor.captureSnapshot({ delegationId, localPath });
    const snap1 = JSON.parse(round1.snapshotBase64);
    expect(snap1.commitHash).toBeTruthy();

    await executor.detach({ delegationId, localPath });

    await writeFile(join(localPath, 'file.txt'), 'v2');
    const round2 = await executor.captureSnapshot({ delegationId, localPath });
    const snap2 = JSON.parse(round2.snapshotBase64);
    expect(snap2.commitHash).toBeTruthy();
    expect(snap2.commitHash).not.toBe(snap1.commitHash);
    expect(snap2.branch).toBe(snap1.branch);

    await executor.detach({ delegationId, localPath });

    await delegator.release(delegationId);
    await executor.release({ delegationId, localPath });

    await expect(
      executor.captureSnapshot({ delegationId, localPath }),
    ).rejects.toThrow(`no active setup for delegation ${delegationId}`);
  });
});
