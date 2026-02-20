export const PROTOCOL_VERSION = '1' as const;

export type MessageType = 'INVITE' | 'ACCEPT' | 'START' | 'DONE' | 'ERROR';

export type AccessMode = 'ro' | 'rw';

export type ResourceType = 'fs';

/** Full resource specification - Delegator internal use */
export interface ResourceSpec {
  name: string;
  type: ResourceType;
  source: string;
  mode: AccessMode;
  /** TODO: Implement file filtering in admission control and transport */
  include?: string[];
  /** TODO: Implement file filtering in admission control and transport */
  exclude?: string[];
}

/** Resource declaration for INVITE */
export interface ResourceDeclaration {
  name: string;
  type: ResourceType;
  mode: AccessMode;
}

export interface EnvironmentSpec {
  resources: ResourceSpec[];
}

/** Environment declaration for INVITE */
export interface EnvironmentDeclaration {
  resources: ResourceDeclaration[];
}

export type AuthType = 'api_key' | 'bearer' | 'oauth2' | 'custom';

export interface AuthCredential {
  type: AuthType;
  credential: string;
  /** TODO: Implement auth metadata handling */
  metadata?: Record<string, string>;
}

export type TransportType = 'sshfs' | 'archive' | 'storage' | 'git';

export type DelegationState =
  | 'created'
  | 'invited'
  | 'accepted'
  | 'started'
  | 'running'
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'expired';

export interface TaskSpec {
  description: string;
  prompt: string;
}

export interface LeaseConfig {
  ttlSeconds: number;
  accessMode: AccessMode;
}

export interface ActiveLease {
  expiresAt: string;
  accessMode: AccessMode;
}

export interface Requirements {
  transport?: TransportType;
}

export interface ExecutorWorkDir {
  path: string;
}

/** TODO: Implement sandbox enforcement in executor */
export interface SandboxProfile {
  cwdOnly?: boolean;
  allowNetwork?: boolean;
  allowExec?: boolean;
}

export interface ExecutorConstraints {
  acceptedAccessMode?: AccessMode;
  /** TODO: Implement TTL validation in delegator before START */
  maxTtlSeconds?: number;
  sandboxProfile?: SandboxProfile;
}

export interface SshEndpoint {
  host: string;
  port: number;
  user: string;
}

export interface SshCredential {
  privateKey: string;
  certificate: string;
}

export interface SshfsTransportHandle {
  transport: 'sshfs';
  endpoint: SshEndpoint;
  exportLocator: string;
  credential: SshCredential;
  options?: Record<string, string>;
}

export interface ArchiveTransportHandle {
  transport: 'archive';
  workspaceBase64: string;
  checksum: string;
}

export interface StorageTransportHandle {
  transport: 'storage';
  downloadUrl: string;
  uploadUrl: string;
  checksum: string;
  expiresAt: string;
  headers?: Record<string, string>;
}

export type GitCredential =
  | { type: 'token'; token: string }
  | { type: 'ssh'; privateKey?: string }
  | { type: 'none' };

export interface GitTransportHandle {
  transport: 'git';
  repoUrl: string;
  baseBranch: string;
  baseCommit: string;
  auth?: GitCredential;
}

export type TransportHandle = SshfsTransportHandle | ArchiveTransportHandle | StorageTransportHandle | GitTransportHandle;

export interface BaseMessage {
  version: typeof PROTOCOL_VERSION;
  type: MessageType;
  delegationId: string;
}

/** INVITE message: Delegator → Executor */
export interface InviteMessage extends BaseMessage {
  type: 'INVITE';
  task: TaskSpec;
  lease: LeaseConfig;
  retentionMs: number;
  environment: EnvironmentDeclaration;
  requirements?: Requirements;
  auth?: AuthCredential;
}

/** ACCEPT message: Executor → Delegator */
export interface AcceptMessage extends BaseMessage {
  type: 'ACCEPT';
  retentionMs: number;
  executorWorkDir: ExecutorWorkDir;
  executorConstraints?: ExecutorConstraints;
}

/** START message: Delegator → Executor */
export interface StartMessage extends BaseMessage {
  type: 'START';
  lease: ActiveLease;
  transportHandle: TransportHandle;
}

/** DONE message: Executor → Delegator (via SSE) */
export interface DoneMessage extends BaseMessage {
  type: 'DONE';
  finalSummary: string;
  highlights?: string[];
  notes?: string;
}

/** ERROR message: Either direction */
export interface ErrorMessage extends BaseMessage {
  type: 'ERROR';
  code: string;
  message: string;
  hint?: string;
}

export type AwcpMessage =
  | InviteMessage
  | AcceptMessage
  | StartMessage
  | DoneMessage
  | ErrorMessage;

// --- Task Events (SSE Streaming) ---

import type { SnapshotMetadata } from './snapshot.js';

export type TaskEventType = 'status' | 'snapshot' | 'done' | 'error';

export interface BaseTaskEvent {
  delegationId: string;
  type: TaskEventType;
  timestamp: string;
}

export interface TaskStatusEvent extends BaseTaskEvent {
  type: 'status';
  status: 'running' | 'progress';
  message?: string;
  /** TODO: Implement progress tracking in executor */
  progress?: number;
}

export interface TaskSnapshotEvent extends BaseTaskEvent {
  type: 'snapshot';
  snapshotId: string;
  summary: string;
  highlights?: string[];
  snapshotBase64: string;
  recommended?: boolean;
  metadata?: SnapshotMetadata;
}

export interface TaskDoneEvent extends BaseTaskEvent {
  type: 'done';
  summary: string;
  highlights?: string[];
  snapshotIds?: string[];
  recommendedSnapshotId?: string;
}

export interface TaskErrorEvent extends BaseTaskEvent {
  type: 'error';
  code: string;
  message: string;
  hint?: string;
}

export type TaskEvent = TaskStatusEvent | TaskSnapshotEvent | TaskDoneEvent | TaskErrorEvent;

// --- Delegation Record ---

import type { EnvironmentSnapshot, SnapshotPolicy } from './snapshot.js';

export interface Delegation {
  id: string;
  state: DelegationState;
  peerUrl: string;
  environment: EnvironmentSpec;
  exportPath?: string;
  task: TaskSpec;
  leaseConfig: LeaseConfig;
  retentionMs: number;
  executorRetentionMs?: number;
  activeLease?: ActiveLease;
  executorWorkDir?: ExecutorWorkDir;
  executorConstraints?: ExecutorConstraints;
  snapshots?: EnvironmentSnapshot[];
  appliedSnapshotId?: string;
  snapshotPolicy?: SnapshotPolicy;
  result?: {
    summary: string;
    highlights?: string[];
  };
  error?: {
    code: string;
    message: string;
    hint?: string;
  };
  createdAt: string;
  updatedAt: string;
}

// --- Assignment Record ---

export type AssignmentState = 'pending' | 'active' | 'completed' | 'error';

export interface Assignment {
  id: string;
  state: AssignmentState;
  invite: InviteMessage;
  workPath: string;
  retentionMs: number;
  lease?: ActiveLease;
  startedAt?: string;
  completedAt?: string;
  result?: {
    summary: string;
    highlights?: string[];
    snapshotBase64?: string;
  };
  error?: {
    code: string;
    message: string;
    hint?: string;
  };
  createdAt: string;
  updatedAt: string;
}
