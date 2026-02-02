/**
 * AWCP Protocol Version
 */
export const PROTOCOL_VERSION = '1' as const;

/**
 * Message Types for AWCP Protocol
 */
export type MessageType = 'INVITE' | 'ACCEPT' | 'START' | 'DONE' | 'ERROR';

/**
 * Access modes for workspace delegation
 */
export type AccessMode = 'ro' | 'rw';

/**
 * Resource types for environment
 */
export type ResourceType = 'fs';

/**
 * Resource specification in environment
 */
export interface ResourceSpec {
  name: string;
  type: ResourceType;
  source: string;
  mode: AccessMode;
  include?: string[];
  exclude?: string[];
}

/**
 * Environment specification - collection of resources for delegation
 */
export interface EnvironmentSpec {
  resources: ResourceSpec[];
}

/**
 * Authentication types for AWCP protocol-level auth
 */
export type AuthType = 'api_key' | 'bearer' | 'oauth2' | 'custom';

/**
 * Authentication credential in INVITE message
 */
export interface AuthCredential {
  type: AuthType;
  credential: string;
  metadata?: Record<string, string>;
}

/**
 * Transport types for data plane
 */
export type TransportType = 'sshfs' | 'archive';

/**
 * Delegation lifecycle states
 */
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

/**
 * Task description for delegation
 */
export interface TaskSpec {
  description: string;
  prompt: string;
}

/**
 * Lease configuration
 */
export interface LeaseConfig {
  ttlSeconds: number;
  accessMode: AccessMode;
}

/**
 * Active lease information (after START)
 */
export interface ActiveLease {
  expiresAt: string;
  accessMode: AccessMode;
}

/**
 * Requirements for Executor to check
 */
export interface Requirements {
  transport?: TransportType;
}

/**
 * Executor work directory specification in ACCEPT
 */
export interface ExecutorWorkDir {
  path: string;
}

/**
 * Sandbox profile - capability declaration by Executor
 */
export interface SandboxProfile {
  cwdOnly?: boolean;
  allowNetwork?: boolean;
  allowExec?: boolean;
}

/**
 * Executor constraints in ACCEPT
 */
export interface ExecutorConstraints {
  acceptedAccessMode?: AccessMode;
  maxTtlSeconds?: number;
  sandboxProfile?: SandboxProfile;
}

/**
 * SSH endpoint for SSHFS transport
 */
export interface SshEndpoint {
  host: string;
  port: number;
  user: string;
}

/**
 * SSH credential for certificate-based authentication
 */
export interface SshCredential {
  privateKey: string;
  certificate: string;
}

/**
 * Work directory information in START message
 */
export interface WorkDirInfo {
  transport: TransportType;
  [key: string]: unknown;
}

/**
 * SSHFS-specific work directory information
 */
export interface SshfsWorkDirInfo extends WorkDirInfo {
  transport: 'sshfs';
  endpoint: SshEndpoint;
  exportLocator: string;
  credential: SshCredential;
  options?: Record<string, string>;
}

/**
 * Archive-specific work directory information
 */
export interface ArchiveWorkDirInfo extends WorkDirInfo {
  transport: 'archive';
  workspaceBase64: string;
  checksum: string;
}

/**
 * Base message structure
 */
export interface BaseMessage {
  version: typeof PROTOCOL_VERSION;
  type: MessageType;
  delegationId: string;
}

/**
 * INVITE message: Delegator → Executor
 */
export interface InviteMessage extends BaseMessage {
  type: 'INVITE';
  task: TaskSpec;
  lease: LeaseConfig;
  environment: EnvironmentSpec;
  requirements?: Requirements;
  auth?: AuthCredential;
}

/**
 * ACCEPT message: Executor → Delegator
 */
export interface AcceptMessage extends BaseMessage {
  type: 'ACCEPT';
  executorWorkDir: ExecutorWorkDir;
  executorConstraints?: ExecutorConstraints;
}

/**
 * START message: Delegator → Executor
 */
export interface StartMessage extends BaseMessage {
  type: 'START';
  lease: ActiveLease;
  workDir: WorkDirInfo;
}

/**
 * DONE message: Executor → Delegator (via SSE)
 */
export interface DoneMessage extends BaseMessage {
  type: 'DONE';
  finalSummary: string;
  highlights?: string[];
  notes?: string;
}

/**
 * ERROR message: Either direction
 */
export interface ErrorMessage extends BaseMessage {
  type: 'ERROR';
  code: string;
  message: string;
  hint?: string;
}

/**
 * Union type for all AWCP messages
 */
export type AwcpMessage =
  | InviteMessage
  | AcceptMessage
  | StartMessage
  | DoneMessage
  | ErrorMessage;

// ============================================
// Task Events (for SSE streaming)
// ============================================

/**
 * Task event types for SSE streaming
 */
export type TaskEventType = 'status' | 'done' | 'error';

/**
 * Base task event structure
 */
export interface BaseTaskEvent {
  delegationId: string;
  type: TaskEventType;
  timestamp: string;
}

/**
 * Status update event
 */
export interface TaskStatusEvent extends BaseTaskEvent {
  type: 'status';
  status: 'running' | 'progress';
  message?: string;
  progress?: number;
}

/**
 * Task completion event
 */
export interface TaskDoneEvent extends BaseTaskEvent {
  type: 'done';
  summary: string;
  highlights?: string[];
  resultBase64?: string;
}

/**
 * Task error event
 */
export interface TaskErrorEvent extends BaseTaskEvent {
  type: 'error';
  code: string;
  message: string;
  hint?: string;
}

/**
 * Union type for all task events
 */
export type TaskEvent = TaskStatusEvent | TaskDoneEvent | TaskErrorEvent;

// ============================================
// Delegation Record
// ============================================

/**
 * Delegation record - full state of a delegation
 */
export interface Delegation {
  id: string;
  state: DelegationState;
  peerUrl: string;
  environment: EnvironmentSpec;
  exportPath?: string;
  task: TaskSpec;
  leaseConfig: LeaseConfig;
  activeLease?: ActiveLease;
  executorWorkDir?: ExecutorWorkDir;
  executorConstraints?: ExecutorConstraints;
  result?: {
    summary: string;
    highlights?: string[];
    notes?: string;
  };
  error?: {
    code: string;
    message: string;
    hint?: string;
  };
  createdAt: string;
  updatedAt: string;
}
