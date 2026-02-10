/**
 * Transport Adapter Interfaces
 */

import type { TransportType, WorkDirInfo } from './messages.js';

export interface TransportCapabilities {
  supportsSnapshots: boolean;
  liveSync: boolean;
}

export interface TransportPrepareParams {
  delegationId: string;
  exportPath: string;
  ttlSeconds: number;
}

export interface TransportPrepareResult {
  workDirInfo: WorkDirInfo;
}

export interface TransportSetupParams {
  delegationId: string;
  workDirInfo: WorkDirInfo;
  workDir: string;
}

export interface TransportReleaseParams {
  delegationId: string;
  workDir: string;
}

export interface TransportCaptureSnapshotParams {
  delegationId: string;
  workDir: string;
}

export interface TransportCaptureSnapshotResult {
  snapshotBase64: string;
}

export interface ResourceMapping {
  name: string;
  source: string;
  mode: 'ro' | 'rw';
}

export interface TransportApplySnapshotParams {
  delegationId: string;
  snapshotData: string;
  resources: ResourceMapping[];
}

export interface DependencyCheckResult {
  available: boolean;
  hint?: string;
}

/** Transport adapter for Delegator side */
export interface DelegatorTransportAdapter {
  readonly type: TransportType;
  readonly capabilities: TransportCapabilities;
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
  prepare(params: TransportPrepareParams): Promise<TransportPrepareResult>;
  applySnapshot?(params: TransportApplySnapshotParams): Promise<void>;
  release(delegationId: string): Promise<void>;
}

/** Transport adapter for Executor side */
export interface ExecutorTransportAdapter {
  readonly type: TransportType;
  readonly capabilities: TransportCapabilities;
  initialize?(workDir: string): Promise<void>;
  shutdown?(): Promise<void>;
  checkDependency(): Promise<DependencyCheckResult>;
  setup(params: TransportSetupParams): Promise<string>;
  captureSnapshot?(params: TransportCaptureSnapshotParams): Promise<TransportCaptureSnapshotResult>;
  release(params: TransportReleaseParams): Promise<void>;
}

/** Full transport adapter implementing both sides */
export type TransportAdapter = DelegatorTransportAdapter & ExecutorTransportAdapter;
