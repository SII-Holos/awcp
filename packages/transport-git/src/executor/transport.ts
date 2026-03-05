import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type {
  ExecutorTransportAdapter,
  TransportCapabilities,
  TransportSetupParams,
  TransportReleaseParams,
  TransportCaptureSnapshotParams,
  TransportCaptureSnapshotResult,
  DependencyCheckResult,
  GitTransportHandle,
} from '@awcp/core';
import type { GitExecutorTransportConfig, GitSnapshotInfo } from '../types.js';
import { execGit, configureAuth, cleanupAuth } from '../utils/index.js';

export class GitExecutorTransport implements ExecutorTransportAdapter {
  readonly type = 'git' as const;
  readonly capabilities: TransportCapabilities = {
    supportsSnapshots: true,
    liveSync: false,
  };

  private tempDir: string;
  private branchPrefix: string;
  private activeSetups = new Map<string, { baseCommit: string; taskBranch: string }>();

  constructor(config: GitExecutorTransportConfig = {}) {
    this.tempDir = config.tempDir ?? path.join(os.tmpdir(), 'awcp-git');
    this.branchPrefix = config.branchPrefix ?? 'awcp/';
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.tempDir, { recursive: true });
  }

  async shutdown(): Promise<void> {
    this.activeSetups.clear();
  }

  async checkDependency(): Promise<DependencyCheckResult> {
    try {
      await execGit(null, ['--version']);
      return { available: true };
    } catch {
      return { available: false, hint: 'Git is not installed or not in PATH' };
    }
  }

  async setup(params: TransportSetupParams): Promise<string> {
    const { delegationId, handle, localPath } = params;

    if (handle.transport !== 'git') {
      throw new Error(`GitExecutorTransport: unexpected transport type: ${handle.transport}`);
    }
    const gitHandle = handle as GitTransportHandle;

    // Clone repository
    await execGit(null, [
      'clone',
      '--branch', gitHandle.baseBranch,
      '--single-branch',
      gitHandle.repoUrl,
      localPath,
    ]);

    // Configure auth for push
    await configureAuth(localPath, gitHandle.auth);

    // Create task branch
    const taskBranch = `${this.branchPrefix}${delegationId}`;
    await execGit(localPath, ['checkout', '-b', taskBranch]);

    // Configure git user
    await execGit(localPath, ['config', 'user.name', 'AWCP Executor']);
    await execGit(localPath, ['config', 'user.email', 'executor@awcp.local']);

    this.activeSetups.set(delegationId, {
      baseCommit: gitHandle.baseCommit,
      taskBranch,
    });

    return localPath;
  }

  async captureSnapshot(params: TransportCaptureSnapshotParams): Promise<TransportCaptureSnapshotResult> {
    const { delegationId, localPath } = params;
    const setup = this.activeSetups.get(delegationId);

    if (!setup) {
      throw new Error(`GitExecutorTransport: no active setup for delegation ${delegationId}`);
    }

    // Commit any uncommitted changes
    const status = await execGit(localPath, ['status', '--porcelain']);
    if (status.trim()) {
      await execGit(localPath, ['add', '-A']);
      await execGit(localPath, ['commit', '-m', `AWCP: Task completed for ${delegationId}`]);
    }

    // Push task branch
    await execGit(localPath, ['push', '-u', 'origin', setup.taskBranch]);

    // Build snapshot info
    const commitHash = (await execGit(localPath, ['rev-parse', 'HEAD'])).trim();
    const changedFilesOutput = await execGit(localPath, ['diff', '--name-only', setup.baseCommit, 'HEAD']);
    const changedFiles = changedFilesOutput.trim().split('\n').filter(Boolean);

    const snapshotInfo: GitSnapshotInfo = {
      branch: setup.taskBranch,
      commitHash,
      baseCommit: setup.baseCommit,
      changedFiles,
    };

    return { snapshotBase64: JSON.stringify(snapshotInfo) };
  }

  async detach(params: TransportReleaseParams): Promise<void> {
    // Clean up auth tokens but keep activeSetups for multi-round sessions.
    // Only release() deletes the setup entry (final cleanup).
    await cleanupAuth(params.localPath).catch(() => {});
  }

  async release(params: TransportReleaseParams): Promise<void> {
    await cleanupAuth(params.localPath).catch(() => {});
    this.activeSetups.delete(params.delegationId);
  }
}
