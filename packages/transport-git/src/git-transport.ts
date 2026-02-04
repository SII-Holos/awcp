/**
 * Git Transport Adapter
 *
 * Implements TransportAdapter interface for Git-based workspace transfer.
 * Supports GitHub, GitLab, Gitea, and self-hosted Git servers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  TransportAdapter,
  TransportCapabilities,
  TransportPrepareParams,
  TransportPrepareResult,
  TransportSetupParams,
  TransportTeardownParams,
  TransportTeardownResult,
  TransportApplySnapshotParams,
  DependencyCheckResult,
  GitWorkDirInfo,
} from '@awcp/core';
import { applyResultToResources } from '@awcp/transport-archive';
import type { GitTransportConfig, GitSnapshotInfo } from './types.js';
import { execGit, configureAuth, cleanupAuth } from './utils/index.js';

export class GitTransport implements TransportAdapter {
  readonly type = 'git' as const;
  readonly capabilities: TransportCapabilities = {
    supportsSnapshots: true,
    liveSync: false,
  };

  private tempDir: string;
  private branchPrefix: string;
  private config: GitTransportConfig;
  private activeRepos = new Map<string, { workDir: string; branch: string }>();
  private activeSetups = new Map<string, { workDir: string; info: GitWorkDirInfo }>();

  constructor(config: GitTransportConfig = {}) {
    this.config = config;
    this.tempDir = config.delegator?.tempDir ?? config.executor?.tempDir ?? path.join(os.tmpdir(), 'awcp-git');
    this.branchPrefix = config.delegator?.branchPrefix ?? 'awcp/';
  }

  // ========== Delegator Side ==========

  async prepare(params: TransportPrepareParams): Promise<TransportPrepareResult> {
    const { delegationId, exportPath } = params;
    const delegatorConfig = this.config.delegator;

    if (!delegatorConfig?.remoteUrl) {
      throw new Error('GitTransport: delegator.remoteUrl is required');
    }

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const gitWorkDir = path.join(this.tempDir, delegationId);

    // Copy files (dereference symlinks)
    await fs.promises.cp(exportPath, gitWorkDir, { recursive: true, dereference: true });
    await fs.promises.rm(path.join(gitWorkDir, '.awcp'), { recursive: true, force: true });

    // Initialize git and commit
    await execGit(gitWorkDir, ['init']);
    await execGit(gitWorkDir, ['add', '-A']);
    await execGit(gitWorkDir, ['commit', '-m', `AWCP: Initial workspace for ${delegationId}`, '--allow-empty']);

    const baseCommit = (await execGit(gitWorkDir, ['rev-parse', 'HEAD'])).trim();

    // Configure remote and push
    await configureAuth(gitWorkDir, delegatorConfig.auth);
    await execGit(gitWorkDir, ['remote', 'add', 'origin', delegatorConfig.remoteUrl]);
    await execGit(gitWorkDir, ['push', '-u', 'origin', 'main', '--force']);

    this.activeRepos.set(delegationId, { workDir: gitWorkDir, branch: 'main' });

    const workDirInfo: GitWorkDirInfo = {
      transport: 'git',
      repoUrl: delegatorConfig.remoteUrl,
      baseBranch: 'main',
      baseCommit,
      auth: delegatorConfig.auth,
    };

    return { workDirInfo };
  }

  async applySnapshot(params: TransportApplySnapshotParams): Promise<void> {
    const { delegationId, snapshotData, resources } = params;

    const snapshotInfo: GitSnapshotInfo = JSON.parse(snapshotData);
    const repo = this.activeRepos.get(delegationId);

    if (!repo) {
      throw new Error(`GitTransport: No active repo for delegation ${delegationId}`);
    }

    await execGit(repo.workDir, ['fetch', 'origin', snapshotInfo.branch]);
    await execGit(repo.workDir, ['merge', `origin/${snapshotInfo.branch}`, '--no-edit']);

    await applyResultToResources(repo.workDir, resources);
  }

  async cleanup(delegationId: string): Promise<void> {
    const repo = this.activeRepos.get(delegationId);
    if (!repo) return;

    if (this.config.delegator?.cleanupRemoteBranch !== false) {
      const taskBranch = `${this.branchPrefix}${delegationId}`;
      await execGit(repo.workDir, ['push', 'origin', '--delete', taskBranch]).catch(() => {});
    }

    await fs.promises.rm(repo.workDir, { recursive: true, force: true });
    this.activeRepos.delete(delegationId);
  }

  async shutdown(): Promise<void> {
    for (const [delegationId] of this.activeRepos) {
      await this.cleanup(delegationId);
    }
  }

  // ========== Executor Side ==========

  async checkDependency(): Promise<DependencyCheckResult> {
    try {
      await execGit(null, ['--version']);
      return { available: true };
    } catch {
      return { available: false, hint: 'Git is not installed or not in PATH' };
    }
  }

  async setup(params: TransportSetupParams): Promise<string> {
    const { delegationId, workDirInfo, workDir } = params;

    if (workDirInfo.transport !== 'git') {
      throw new Error(`GitTransport: unexpected transport type: ${workDirInfo.transport}`);
    }

    const info = workDirInfo as GitWorkDirInfo;

    // Clone repository
    await execGit(null, [
      'clone',
      '--branch', info.baseBranch,
      '--single-branch',
      info.repoUrl,
      workDir,
    ]);

    // Configure auth for push
    await configureAuth(workDir, info.auth);

    // Create task branch
    const taskBranch = `${this.branchPrefix}${delegationId}`;
    await execGit(workDir, ['checkout', '-b', taskBranch]);

    // Configure git user
    await execGit(workDir, ['config', 'user.name', 'AWCP Executor']);
    await execGit(workDir, ['config', 'user.email', 'executor@awcp.local']);

    this.activeSetups.set(delegationId, { workDir, info });

    return workDir;
  }

  async teardown(params: TransportTeardownParams): Promise<TransportTeardownResult> {
    const { delegationId, workDir } = params;
    const setup = this.activeSetups.get(delegationId);

    if (!setup) {
      return {};
    }

    const taskBranch = `${this.branchPrefix}${delegationId}`;

    // Check for changes
    const status = await execGit(workDir, ['status', '--porcelain']);

    if (status.trim()) {
      await execGit(workDir, ['add', '-A']);
      await execGit(workDir, ['commit', '-m', `AWCP: Task completed for ${delegationId}`]);
    }

    // Push task branch
    await execGit(workDir, ['push', '-u', 'origin', taskBranch]);

    // Get snapshot info
    const commitHash = (await execGit(workDir, ['rev-parse', 'HEAD'])).trim();
    const changedFilesOutput = await execGit(workDir, ['diff', '--name-only', setup.info.baseCommit, 'HEAD']);
    const changedFiles = changedFilesOutput.trim().split('\n').filter(Boolean);

    this.activeSetups.delete(delegationId);
    await cleanupAuth(workDir);

    const snapshotInfo: GitSnapshotInfo = {
      branch: taskBranch,
      commitHash,
      baseCommit: setup.info.baseCommit,
      changedFiles,
    };

    return { snapshotBase64: JSON.stringify(snapshotInfo) };
  }
}
