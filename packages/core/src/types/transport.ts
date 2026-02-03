/**
 * Transport Adapter Interfaces
 */

import type { TransportType, WorkDirInfo } from './messages.js';

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

export interface TransportTeardownParams {
  delegationId: string;
  workDir: string;
}

export interface TransportTeardownResult {
  resultBase64?: string;
}

export interface ResourceMapping {
  name: string;
  source: string;
  mode: 'ro' | 'rw';
}

export interface TransportApplyResultParams {
  delegationId: string;
  resultData: string;
  resources: ResourceMapping[];
}

export interface DependencyCheckResult {
  available: boolean;
  hint?: string;
}

/** Transport adapter for Delegator side */
export interface DelegatorTransportAdapter {
  readonly type: TransportType;
  prepare(params: TransportPrepareParams): Promise<TransportPrepareResult>;
  applyResult?(params: TransportApplyResultParams): Promise<void>;
  cleanup(delegationId: string): Promise<void>;
}

/** Transport adapter for Executor side */
export interface ExecutorTransportAdapter {
  readonly type: TransportType;
  checkDependency(): Promise<DependencyCheckResult>;
  setup(params: TransportSetupParams): Promise<string>;
  teardown(params: TransportTeardownParams): Promise<TransportTeardownResult>;
}

/** Full transport adapter implementing both sides */
export type TransportAdapter = DelegatorTransportAdapter & ExecutorTransportAdapter;
