/**
 * SSHFS Transport Adapter
 * 
 * Implements TransportAdapter interface for SSHFS transport.
 */

import type {
  TransportAdapter,
  TransportCapabilities,
  TransportPrepareParams,
  TransportPrepareResult,
  TransportSetupParams,
  TransportTeardownParams,
  TransportTeardownResult,
  DependencyCheckResult,
  SshfsWorkDirInfo,
} from '@awcp/core';
import { CredentialManager } from './delegator/credential-manager.js';
import { SshfsMountClient } from './executor/sshfs-client.js';
import type { SshfsTransportConfig } from './types.js';

export class SshfsTransport implements TransportAdapter {
  readonly type = 'sshfs' as const;
  readonly capabilities: TransportCapabilities = {
    supportsSnapshots: false,
    liveSync: true,
  };

  private config: SshfsTransportConfig;
  private credentialManager?: CredentialManager;
  private mountClient?: SshfsMountClient;

  constructor(config: SshfsTransportConfig = {}) {
    this.config = config;
  }

  // ========== Delegator Side ==========

  async prepare(params: TransportPrepareParams): Promise<TransportPrepareResult> {
    if (!this.credentialManager) {
      if (!this.config.delegator?.caKeyPath) {
        throw new Error('SshfsTransport: delegator.caKeyPath is required for Delegator operations');
      }
      this.credentialManager = new CredentialManager({
        keyDir: this.config.delegator.keyDir,
        sshHost: this.config.delegator.host,
        sshPort: this.config.delegator.port,
        sshUser: this.config.delegator.user,
        caKeyPath: this.config.delegator.caKeyPath,
      });
    }

    const { delegationId, exportPath, ttlSeconds } = params;
    const { credential, endpoint } = await this.credentialManager.generateCredential(
      delegationId,
      ttlSeconds,
    );

    const workDirInfo: SshfsWorkDirInfo = {
      transport: 'sshfs',
      endpoint,
      exportLocator: exportPath,
      credential,
    };

    return { workDirInfo };
  }

  async cleanup(delegationId: string): Promise<void> {
    await this.credentialManager?.revokeCredential(delegationId);
  }

  // ========== Executor Side ==========

  async checkDependency(): Promise<DependencyCheckResult> {
    this.ensureMountClient();
    const result = await this.mountClient!.checkDependency();

    return {
      available: result.available,
      hint: result.available
        ? undefined
        : 'Install sshfs: brew install macfuse && brew install sshfs (macOS) or apt install sshfs (Linux)',
    };
  }

  async setup(params: TransportSetupParams): Promise<string> {
    this.ensureMountClient();
    const { workDirInfo, workDir } = params;

    if (workDirInfo.transport !== 'sshfs') {
      throw new Error(`SshfsTransport: unexpected transport type: ${workDirInfo.transport}`);
    }

    const info = workDirInfo as SshfsWorkDirInfo;
    await this.mountClient!.mount({
      endpoint: info.endpoint,
      exportLocator: info.exportLocator,
      credential: info.credential,
      mountPoint: workDir,
      options: info.options,
    });

    return workDir;
  }

  async teardown(params: TransportTeardownParams): Promise<TransportTeardownResult> {
    await this.mountClient?.unmount(params.workDir);
    return {};
  }

  // ========== Helpers ==========

  private ensureMountClient(): void {
    if (!this.mountClient) {
      this.mountClient = new SshfsMountClient({
        tempKeyDir: this.config.executor?.tempKeyDir,
        defaultOptions: this.config.executor?.defaultMountOptions,
        mountTimeout: this.config.executor?.mountTimeout,
      });
    }
  }

  async unmountAll(): Promise<void> {
    await this.mountClient?.unmountAll();
  }

  async revokeAllCredentials(): Promise<void> {
    await this.credentialManager?.revokeAll();
  }

  async cleanupStaleKeyFiles(): Promise<number> {
    return this.credentialManager?.cleanupStaleKeyFiles() ?? 0;
  }
}
