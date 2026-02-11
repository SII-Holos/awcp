/**
 * SSHFS Transport Configuration Types
 */

export interface SshfsDelegatorTransportConfig {
  keyDir?: string;
  caKeyPath: string;
  host?: string;
  port?: number;
  user?: string;
}

export interface SshfsExecutorTransportConfig {
  tempKeyDir?: string;
  defaultMountOptions?: Record<string, string>;
  mountTimeout?: number;
}

// --- Internal Types ---

export interface CredentialManagerConfig {
  keyDir?: string;
  caKeyPath: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
}

export interface GeneratedCredential {
  privateKey: string;
  privateKeyPath: string;
  publicKeyPath: string;
  certPath: string;
  delegationId: string;
}

export interface SshfsMountConfig {
  tempKeyDir?: string;
  defaultOptions?: Record<string, string>;
  mountTimeout?: number;
}

export interface MountParams {
  endpoint: {
    host: string;
    port: number;
    user: string;
  };
  exportLocator: string;
  credential: {
    privateKey: string;
    certificate: string;
  };
  mountPoint: string;
  options?: Record<string, string>;
}

export interface ActiveMount {
  mountPoint: string;
  keyPath: string;
  certPath: string;
}
