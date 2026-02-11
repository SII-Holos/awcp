import type {
  ExecutorTransportAdapter,
  TransportCapabilities,
  TransportSetupParams,
  TransportReleaseParams,
  DependencyCheckResult,
  SshfsTransportHandle,
} from '@awcp/core';
import { SshfsMountClient } from './sshfs-client.js';
import type { SshfsExecutorTransportConfig } from '../types.js';

export class SshfsExecutorTransport implements ExecutorTransportAdapter {
  readonly type = 'sshfs' as const;
  readonly capabilities: TransportCapabilities = {
    supportsSnapshots: false,
    liveSync: true,
  };

  private mountClient: SshfsMountClient;

  constructor(config: SshfsExecutorTransportConfig = {}) {
    this.mountClient = new SshfsMountClient({
      tempKeyDir: config.tempKeyDir,
      defaultOptions: config.defaultMountOptions,
      mountTimeout: config.mountTimeout,
    });
  }

  async shutdown(): Promise<void> {
    await this.mountClient.unmountAll();
  }

  async checkDependency(): Promise<DependencyCheckResult> {
    const result = await this.mountClient.checkDependency();
    return {
      available: result.available,
      hint: result.available
        ? undefined
        : 'Install sshfs: brew install macfuse && brew install sshfs (macOS) or apt install sshfs (Linux)',
    };
  }

  async setup(params: TransportSetupParams): Promise<string> {
    const { handle, localPath } = params;

    if (handle.transport !== 'sshfs') {
      throw new Error(`SshfsExecutorTransport: unexpected transport type: ${handle.transport}`);
    }

    const info = handle as SshfsTransportHandle;
    await this.mountClient.mount({
      endpoint: info.endpoint,
      exportLocator: info.exportLocator,
      credential: info.credential,
      mountPoint: localPath,
      options: info.options,
    });

    return localPath;
  }

  async detach(params: TransportReleaseParams): Promise<void> {
    await this.mountClient.unmount(params.localPath);
  }

  async release(params: TransportReleaseParams): Promise<void> {
    await this.mountClient.forceUnmount(params.localPath);
  }
}
