import type {
  DelegatorTransportAdapter,
  TransportCapabilities,
  TransportPrepareParams,
  TransportHandle,
  SshfsTransportHandle,
} from '@awcp/core';
import { CredentialManager } from './credential-manager.js';
import type { SshfsDelegatorTransportConfig } from '../types.js';

export class SshfsDelegatorTransport implements DelegatorTransportAdapter {
  readonly type = 'sshfs' as const;
  readonly capabilities: TransportCapabilities = {
    supportsSnapshots: false,
    liveSync: true,
  };

  private credentialManager: CredentialManager;

  constructor(config: SshfsDelegatorTransportConfig) {
    this.credentialManager = new CredentialManager({
      keyDir: config.keyDir,
      caKeyPath: config.caKeyPath,
      sshHost: config.host,
      sshPort: config.port,
      sshUser: config.user,
    });
  }

  async initialize(): Promise<void> {
    await this.credentialManager.loadAll();
  }

  async shutdown(): Promise<void> {
    await this.credentialManager.revokeAll();
  }

  async prepare(params: TransportPrepareParams): Promise<TransportHandle> {
    const { delegationId, exportPath, ttlSeconds } = params;
    const { credential, endpoint } = await this.credentialManager.generateCredential(
      delegationId,
      ttlSeconds,
    );

    const handle: SshfsTransportHandle = {
      transport: 'sshfs',
      endpoint,
      exportLocator: exportPath,
      credential,
    };

    return handle;
  }

  async detach(delegationId: string): Promise<void> {
    await this.credentialManager.revokeCredential(delegationId);
  }

  async release(delegationId: string): Promise<void> {
    await this.credentialManager.revokeCredential(delegationId);
  }
}
