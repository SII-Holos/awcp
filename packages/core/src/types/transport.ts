/**
 * Transport Adapter Interfaces
 */

import type { TransportType, TransportHandle } from './messages.js';

export interface TransportCapabilities {
  supportsSnapshots: boolean;
  liveSync: boolean;
}

export interface TransportPrepareParams {
  delegationId: string;
  exportPath: string;
  ttlSeconds: number;
}

export interface TransportSetupParams {
  delegationId: string;
  handle: TransportHandle;
  localPath: string;
}

export interface TransportReleaseParams {
  delegationId: string;
  localPath: string;
}

export interface TransportCaptureSnapshotParams {
  delegationId: string;
  localPath: string;
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
  prepare(params: TransportPrepareParams): Promise<TransportHandle>;
  applySnapshot?(params: TransportApplySnapshotParams): Promise<void>;
  detach(delegationId: string): Promise<void>;
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
  detach(params: TransportReleaseParams): Promise<void>;
  release(params: TransportReleaseParams): Promise<void>;
}
