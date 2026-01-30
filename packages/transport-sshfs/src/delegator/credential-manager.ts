import { unlink, mkdir, readFile, readdir, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { SshCredential } from '@awcp/core';

/**
 * SSH Credential Manager configuration
 */
export interface CredentialManagerConfig {
  /** Directory to store temporary keys (default: ~/.awcp/keys) */
  keyDir?: string;
  /** SSH server port (default: 22) */
  sshPort?: number;
  /** SSH server host (default: localhost) */
  sshHost?: string;
  /** SSH user for connections */
  sshUser?: string;
  /** Path to CA private key for signing certificates */
  caKeyPath: string;
}

/**
 * Generated credential
 */
export interface GeneratedCredential {
  /** The private key content */
  privateKey: string;
  /** Path to the private key file */
  privateKeyPath: string;
  /** Path to the public key file */
  publicKeyPath: string;
  /** Path to the certificate file */
  certPath: string;
  /** Delegation ID for tracking */
  delegationId: string;
}

const DEFAULT_KEY_DIR = join(homedir(), '.awcp', 'keys');

/**
 * SSH Credential Manager
 *
 * Manages temporary SSH certificates for AWCP delegations.
 * Uses SSH certificates with built-in expiry for automatic TTL enforcement.
 */
export class CredentialManager {
  private config: CredentialManagerConfig;
  private activeCredentials = new Map<string, GeneratedCredential>();

  constructor(config: CredentialManagerConfig) {
    this.config = config;
  }

  /**
   * Generate a temporary SSH key pair and sign certificate with TTL
   */
  async generateCredential(
    delegationId: string,
    ttlSeconds: number,
  ): Promise<{
    credential: SshCredential;
    endpoint: { host: string; port: number; user: string };
  }> {
    // Ensure CA key exists (auto-generate if needed)
    await this.ensureCaKey();

    const keyDir = this.config.keyDir ?? DEFAULT_KEY_DIR;
    await mkdir(keyDir, { recursive: true, mode: 0o700 });

    const privateKeyPath = join(keyDir, delegationId);
    const publicKeyPath = join(keyDir, `${delegationId}.pub`);
    const certPath = join(keyDir, `${delegationId}-cert.pub`);

    // Generate key pair
    await this.execSshKeygen(privateKeyPath, `awcp-${delegationId}`);

    // Sign certificate with CA (includes TTL)
    await this.signCertificate(publicKeyPath, ttlSeconds, delegationId);

    // Read the private key and certificate
    const privateKey = await readFile(privateKeyPath, 'utf-8');
    const certificate = await readFile(certPath, 'utf-8');

    const credentialInfo: GeneratedCredential = {
      privateKey,
      privateKeyPath,
      publicKeyPath,
      certPath,
      delegationId,
    };

    this.activeCredentials.set(delegationId, credentialInfo);

    return {
      credential: {
        privateKey,
        certificate,
      },
      endpoint: {
        host: this.config.sshHost ?? 'localhost',
        port: this.config.sshPort ?? 22,
        user: this.config.sshUser ?? process.env['USER'] ?? 'awcp',
      },
    };
  }

  /**
   * Ensure CA key exists, auto-generate if not present
   */
  private async ensureCaKey(): Promise<void> {
    try {
      await access(this.config.caKeyPath, constants.R_OK);
      return; // CA key exists
    } catch {
      // CA key doesn't exist, generate it
    }

    console.log(`[CredentialManager] CA key not found at ${this.config.caKeyPath}, generating...`);

    const caDir = join(this.config.caKeyPath, '..');
    await mkdir(caDir, { recursive: true, mode: 0o700 });

    await this.execSshKeygen(this.config.caKeyPath, 'awcp-ca');

    console.log(`[CredentialManager] CA key pair generated at ${this.config.caKeyPath}`);
    console.log('');
    console.log('  ⚠️  To enable SSH certificate authentication, add to /etc/ssh/sshd_config:');
    console.log(`     TrustedUserCAKeys ${this.config.caKeyPath}.pub`);
    console.log('');
    console.log('  Then restart sshd:');
    console.log('     macOS:  sudo launchctl stop com.openssh.sshd');
    console.log('     Linux:  sudo systemctl restart sshd');
    console.log('');
  }

  /**
   * Revoke a credential (delete key files, certificate expires automatically)
   */
  async revokeCredential(delegationId: string): Promise<void> {
    const credential = this.activeCredentials.get(delegationId);
    if (!credential) {
      return;
    }

    // Delete key and certificate files
    await unlink(credential.privateKeyPath).catch(() => {});
    await unlink(credential.publicKeyPath).catch(() => {});
    await unlink(credential.certPath).catch(() => {});

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

  /**
   * Clean up stale key files from key directory (call on startup)
   */
  async cleanupStaleKeyFiles(): Promise<number> {
    const keyDir = this.config.keyDir ?? DEFAULT_KEY_DIR;

    try {
      const files = await readdir(keyDir);
      let removedCount = 0;

      for (const file of files) {
        // Extract delegation ID from filename
        const delegationId = file.replace(/(-cert)?\.pub$/, '');
        if (this.activeCredentials.has(delegationId)) {
          continue;
        }

        // Remove stale key files
        await unlink(join(keyDir, file)).catch(() => {});
        removedCount++;
      }

      if (removedCount > 0) {
        console.log(`[CredentialManager] Cleaned up ${removedCount} stale key files`);
      }

      return removedCount;
    } catch {
      // Directory doesn't exist, nothing to clean
      return 0;
    }
  }

  /**
   * Sign public key with CA to create certificate with TTL
   */
  private signCertificate(
    publicKeyPath: string,
    ttlSeconds: number,
    delegationId: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('ssh-keygen', [
        '-s', this.config.caKeyPath,
        '-I', `awcp-${delegationId}`,
        '-n', this.config.sshUser ?? process.env['USER'] ?? 'awcp',
        '-V', `+${ttlSeconds}s`,
        '-q',
        publicKeyPath,
      ]);

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Certificate signing failed: ${stderr}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * Execute ssh-keygen to generate a key pair
   */
  private execSshKeygen(keyPath: string, comment: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('ssh-keygen', [
        '-t', 'ed25519',
        '-f', keyPath,
        '-N', '', // No passphrase
        '-C', comment,
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
