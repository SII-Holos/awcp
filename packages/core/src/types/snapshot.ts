/**
 * Environment Snapshot Types
 */

export type SnapshotStatus = 'pending' | 'applied' | 'discarded';

export type SnapshotPolicy = 'auto' | 'staged' | 'discard';

export interface SnapshotMetadata {
  fileCount?: number;
  totalBytes?: number;
  changedFiles?: string[];
  [key: string]: unknown;
}

export interface SnapshotPolicyConfig {
  mode: SnapshotPolicy;
  retentionMs?: number;
  maxSnapshots?: number;
}

export interface EnvironmentSnapshot {
  id: string;
  delegationId: string;
  summary: string;
  highlights?: string[];
  status: SnapshotStatus;
  localPath?: string;
  metadata?: SnapshotMetadata;
  recommended?: boolean;
  createdAt: string;
  appliedAt?: string;
}
