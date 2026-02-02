import { unlink, mkdir, readFile, readdir, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { SshCredential } from '@awcp/core';
import type { CredentialManagerConfig, GeneratedCredential } from '../types.js';

const DEFAULT_KEY_DIR = join(homedir(), '.awcp', 'keys');

/**
 * Manages temporary SSH certificates for AWCP delegations.
 * Uses SSH certificates with built-in expiry for automatic TTL enforcement.
 */
export class CredentialManager {
  private config: CredentialManagerConfig;
  private activeCredentials = new Map<string, GeneratedCredential>();

  constructor(config: CredentialManagerConfig) {
    this.config = config;
  }

  async generateCredential(
    delegationId: string,
    ttlSeconds: number,
  ): Promise<{
    credential: SshCredential;
    endpoint: { host: string; port: number; user: string };
  }> {
    await this.ensureCaKey();

    const keyDir = this.config.keyDir ?? DEFAULT_KEY_DIR;
    await mkdir(keyDir, { recursive: true, mode: 0o700 });

    const privateKeyPath = join(keyDir, delegationId);
    const publicKeyPath = join(keyDir, `${delegationId}.pub`);
    const certPath = join(keyDir, `${delegationId}-cert.pub`);

    await this.execSshKeygen(privateKeyPath, `awcp-${delegationId}`);
    await this.signCertificate(publicKeyPath, ttlSeconds, delegationId);

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
      credential: { privateKey, certificate },
      endpoint: {
        host: this.config.sshHost ?? 'localhost',
        port: this.config.sshPort ?? 22,
        user: this.config.sshUser ?? process.env['USER'] ?? 'awcp',
      },
    };
  }

  private async ensureCaKey(): Promise<void> {
    try {
      await access(this.config.caKeyPath, constants.R_OK);
      return;
    } catch {
      // CA key doesn't exist, generate it
    }

    console.log(`[AWCP:Credentials] CA key not found at ${this.config.caKeyPath}, generating...`);

    const caDir = join(this.config.caKeyPath, '..');
    await mkdir(caDir, { recursive: true, mode: 0o700 });

    await this.execSshKeygen(this.config.caKeyPath, 'awcp-ca');

    console.log(`[AWCP:Credentials] CA key pair generated at ${this.config.caKeyPath}`);
    console.log('');
    console.log('  To enable SSH certificate authentication, add to /etc/ssh/sshd_config:');
    console.log(`     TrustedUserCAKeys ${this.config.caKeyPath}.pub`);
    console.log('');
    console.log('  Then restart sshd:');
    console.log('     macOS:  sudo launchctl stop com.openssh.sshd');
    console.log('     Linux:  sudo systemctl restart sshd');
    console.log('');
  }

  async revokeCredential(delegationId: string): Promise<void> {
    const credential = this.activeCredentials.get(delegationId);
    if (!credential) return;

    await unlink(credential.privateKeyPath).catch(() => {});
    await unlink(credential.publicKeyPath).catch(() => {});
    await unlink(credential.certPath).catch(() => {});

    this.activeCredentials.delete(delegationId);
  }

  getCredential(delegationId: string): GeneratedCredential | undefined {
    return this.activeCredentials.get(delegationId);
  }

  async revokeAll(): Promise<void> {
    for (const delegationId of this.activeCredentials.keys()) {
      await this.revokeCredential(delegationId);
    }
  }

  async cleanupStaleKeyFiles(): Promise<number> {
    const keyDir = this.config.keyDir ?? DEFAULT_KEY_DIR;

    try {
      const files = await readdir(keyDir);
      let removedCount = 0;

      for (const file of files) {
        const delegationId = file.replace(/(-cert)?\.pub$/, '');
        if (this.activeCredentials.has(delegationId)) {
          continue;
        }

        await unlink(join(keyDir, file)).catch(() => {});
        removedCount++;
      }

      if (removedCount > 0) {
        console.log(`[AWCP:Credentials] Cleaned up ${removedCount} stale key files`);
      }

      return removedCount;
    } catch {
      return 0;
    }
  }

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

  private execSshKeygen(keyPath: string, comment: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('ssh-keygen', [
        '-t', 'ed25519',
        '-f', keyPath,
        '-N', '',
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
