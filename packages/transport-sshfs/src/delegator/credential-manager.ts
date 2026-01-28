import { unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * SSH Credential Manager configuration
 */
export interface CredentialManagerConfig {
  /** Directory to store temporary keys (default: /tmp/awcp/keys) */
  keyDir?: string;
  /** SSH server port (default: 22) */
  sshPort?: number;
  /** SSH server host (default: localhost) */
  sshHost?: string;
  /** SSH user for connections */
  sshUser?: string;
}

/**
 * Generated credential
 */
export interface GeneratedCredential {
  /** The private key content */
  privateKey: string;
  /** The public key content */
  publicKey: string;
  /** Path to the private key file */
  privateKeyPath: string;
  /** Path to the public key file */
  publicKeyPath: string;
}

const DEFAULT_KEY_DIR = '/tmp/awcp/keys';

/**
 * SSH Credential Manager
 * 
 * Manages temporary SSH keys for AWCP delegations.
 * In production, this should integrate with proper SSH CA or key management.
 */
export class CredentialManager {
  private config: CredentialManagerConfig;
  private activeCredentials = new Map<string, GeneratedCredential>();

  constructor(config?: CredentialManagerConfig) {
    this.config = config ?? {};
  }

  /**
   * Generate a temporary SSH key pair for a delegation
   * 
   * Note: This is a simplified implementation. Production systems should:
   * - Use SSH certificates with short TTLs
   * - Integrate with a CA for proper key signing
   * - Use hardware security modules for key generation
   */
  async generateCredential(
    delegationId: string,
    _ttlSeconds: number,
  ): Promise<{
    credential: string;
    endpoint: { host: string; port: number; user: string };
  }> {
    const keyDir = this.config.keyDir ?? DEFAULT_KEY_DIR;
    await mkdir(keyDir, { recursive: true });

    const privateKeyPath = join(keyDir, `${delegationId}`);
    const publicKeyPath = join(keyDir, `${delegationId}.pub`);

    // Generate key pair using ssh-keygen
    await this.execSshKeygen(privateKeyPath);

    // Read the generated keys
    const { readFile } = await import('node:fs/promises');
    const privateKey = await readFile(privateKeyPath, 'utf-8');
    const publicKey = await readFile(publicKeyPath, 'utf-8');

    const credential: GeneratedCredential = {
      privateKey,
      publicKey,
      privateKeyPath,
      publicKeyPath,
    };

    this.activeCredentials.set(delegationId, credential);

    // TODO: In production, add public key to authorized_keys with expiry
    // For now, we just return the private key as the credential

    return {
      credential: privateKey,
      endpoint: {
        host: this.config.sshHost ?? 'localhost',
        port: this.config.sshPort ?? 22,
        user: this.config.sshUser ?? process.env['USER'] ?? 'awcp',
      },
    };
  }

  /**
   * Revoke a credential
   */
  async revokeCredential(delegationId: string): Promise<void> {
    const credential = this.activeCredentials.get(delegationId);
    if (!credential) {
      return;
    }

    // Remove key files
    try {
      await unlink(credential.privateKeyPath);
      await unlink(credential.publicKeyPath);
    } catch {
      // Ignore errors if files don't exist
    }

    // TODO: In production, remove from authorized_keys

    this.activeCredentials.delete(delegationId);
  }

  /**
   * Get credential info for a delegation
   */
  getCredential(delegationId: string): GeneratedCredential | undefined {
    return this.activeCredentials.get(delegationId);
  }

  /**
   * Revoke all credentials
   */
  async revokeAll(): Promise<void> {
    for (const delegationId of this.activeCredentials.keys()) {
      await this.revokeCredential(delegationId);
    }
  }

  private execSshKeygen(keyPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('ssh-keygen', [
        '-t', 'ed25519',
        '-f', keyPath,
        '-N', '', // No passphrase
        '-C', `awcp-temp-key`,
      ]);

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ssh-keygen failed: ${stderr}`));
        }
      });

      proc.on('error', reject);
    });
  }
}
