import type { GitCredential } from '@awcp/core';

export type { GitWorkDirInfo, GitCredential } from '@awcp/core';

export interface GitDelegatorConfig {
  remoteUrl: string;
  auth: GitCredential;
  tempDir?: string;
  branchPrefix?: string;
  cleanupRemoteBranch?: boolean;
}

export interface GitExecutorConfig {
  tempDir?: string;
  gitPath?: string;
  cloneTimeout?: number;
}

export interface GitTransportConfig {
  delegator?: GitDelegatorConfig;
  executor?: GitExecutorConfig;
}

export interface GitSnapshotInfo {
  branch: string;
  commitHash: string;
  baseCommit: string;
  changedFiles: string[];
}
