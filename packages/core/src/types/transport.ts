/**
 * Transport Adapter Interface
 *
 * Abstract interface that all transport implementations must implement.
 * Enables pluggable transports (sshfs, archive, webdav, etc.)
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

export interface DependencyCheckResult {
  available: boolean;
  hint?: string;
}

/**
 * Transport Adapter Interface
 *
 * All transport implementations (sshfs, archive, etc.) must implement this.
 *
 * Lifecycle:
 * - Delegator: prepare() -> [task runs] -> cleanup()
 * - Executor: checkDependency() -> setup() -> [task runs] -> teardown()
 */
export interface TransportAdapter {
  readonly type: TransportType;

  // --- Delegator Side ---

  /** Prepare transport after ACCEPT received, before sending START */
  prepare(params: TransportPrepareParams): Promise<TransportPrepareResult>;

  /** Clean up resources after task completion or expiration */
  cleanup(delegationId: string): Promise<void>;

  // --- Executor Side ---

  /** Check if transport dependencies are available */
  checkDependency(): Promise<DependencyCheckResult>;

  /** Set up workspace for task execution after START received */
  setup(params: TransportSetupParams): Promise<string>;

  /** Tear down workspace after task completion */
  teardown(params: TransportTeardownParams): Promise<TransportTeardownResult>;
}

/** Transport adapter for Delegator side only */
export interface DelegatorTransportAdapter {
  readonly type: TransportType;
  prepare(params: TransportPrepareParams): Promise<TransportPrepareResult>;
  cleanup(delegationId: string): Promise<void>;
}

/** Transport adapter for Executor side only */
export interface ExecutorTransportAdapter {
  readonly type: TransportType;
  checkDependency(): Promise<DependencyCheckResult>;
  setup(params: TransportSetupParams): Promise<string>;
  teardown(params: TransportTeardownParams): Promise<TransportTeardownResult>;
}
