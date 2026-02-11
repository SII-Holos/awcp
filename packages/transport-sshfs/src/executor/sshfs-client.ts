import { spawn } from 'node:child_process';
import { writeFile, unlink, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SetupFailedError, DependencyMissingError, type SshCredential } from '@awcp/core';
import type { SshfsMountConfig, MountParams, ActiveMount } from '../types.js';

export const DEFAULT_TEMP_KEY_DIR = '/tmp/awcp/client-keys';
const DEFAULT_MOUNT_TIMEOUT = 30000;

/**
 * Build SSHFS command arguments
 */
export function buildSshfsArgs(
  params: MountParams,
  keyPath: string,
  certPath: string,
  defaultOptions?: Record<string, string>,
): string[] {
  const { host, port, user } = params.endpoint;
  const remoteSpec = `${user}@${host}:${params.exportLocator}`;
  
  const options = {
    ...defaultOptions,
    ...params.options,
  };

  const args = [
    remoteSpec,
    params.mountPoint,
    '-o', `IdentityFile=${keyPath}`,
    '-o', `CertificateFile=${certPath}`,
    '-o', `Port=${port}`,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'reconnect',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'noappledouble',
    '-o', 'follow_symlinks',
  ];

  for (const [key, value] of Object.entries(options)) {
    args.push('-o', `${key}=${value}`);
  }

  return args;
}

/**
 * SSHFS Mount Client
 * 
 * Handles mounting remote filesystems via SSHFS on the executor side.
 */
export class SshfsMountClient {
  private config: SshfsMountConfig;
  private activeMounts = new Map<string, ActiveMount>();

  constructor(config?: SshfsMountConfig) {
    this.config = config ?? {};
  }

  getActiveMounts(): Map<string, ActiveMount> {
    return this.activeMounts;
  }

  async checkDependency(): Promise<{ available: boolean; version?: string; error?: string }> {
    return new Promise((resolve) => {
      const proc = spawn('sshfs', ['--version']);
      
      let output = '';
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });
      proc.stderr.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 || output.includes('SSHFS')) {
          const versionMatch = output.match(/SSHFS version ([\d.]+)/);
          resolve({
            available: true,
            version: versionMatch?.[1],
          });
        } else {
          resolve({
            available: false,
            error: 'sshfs not found',
          });
        }
      });

      proc.on('error', () => {
        resolve({
          available: false,
          error: 'sshfs not found in PATH',
        });
      });
    });
  }

  async writeCredentialFiles(
    tempKeyDir: string,
    credential: SshCredential,
  ): Promise<{ keyPath: string; certPath: string }> {
    await mkdir(tempKeyDir, { recursive: true });

    const keyPath = join(tempKeyDir, `mount-${Date.now()}`);
    const certPath = `${keyPath}-cert.pub`;
    await writeFile(keyPath, credential.privateKey, { mode: 0o600 });
    await writeFile(certPath, credential.certificate, { mode: 0o644 });

    return { keyPath, certPath };
  }

  async cleanupCredentialFiles(keyPath: string, certPath: string): Promise<void> {
    await unlink(keyPath).catch(() => {});
    await unlink(certPath).catch(() => {});
  }

  async mount(params: MountParams): Promise<void> {
    const depCheck = await this.checkDependency();
    if (!depCheck.available) {
      throw new DependencyMissingError(
        'sshfs',
        'Install sshfs: brew install macfuse && brew install sshfs (macOS) or apt install sshfs (Linux)',
      );
    }

    const tempKeyDir = this.config.tempKeyDir ?? DEFAULT_TEMP_KEY_DIR;
    const { keyPath, certPath } = await this.writeCredentialFiles(tempKeyDir, params.credential);

    try {
      const args = buildSshfsArgs(params, keyPath, certPath, this.config.defaultOptions);

      console.log(`[AWCP:SSHFS] Mounting: sshfs ${args.join(' ')}`);

      await this.execMount(args, params.mountPoint);

      this.activeMounts.set(params.mountPoint, {
        mountPoint: params.mountPoint,
        keyPath,
        certPath,
      });

    } catch (error) {
      await this.cleanupCredentialFiles(keyPath, certPath);
      throw error;
    }
  }

  async unmount(mountPoint: string): Promise<void> {
    const activeMount = this.activeMounts.get(mountPoint);

    const unmountCommands = [
      ['umount', mountPoint],
      ['fusermount', '-u', mountPoint],
      ['diskutil', 'unmount', mountPoint],
    ];

    let success = false;
    for (const cmd of unmountCommands) {
      try {
        await this.execCommand(cmd[0]!, cmd.slice(1));
        success = true;
        break;
      } catch {
        // Try next method
      }
    }

    if (!success) {
      console.warn(`[AWCP:SSHFS] Failed to unmount ${mountPoint}, may need manual cleanup`);
    }

    if (activeMount) {
      await this.cleanupCredentialFiles(activeMount.keyPath, activeMount.certPath);
      this.activeMounts.delete(mountPoint);
    }
  }

  async unmountAll(): Promise<void> {
    for (const mountPoint of this.activeMounts.keys()) {
      await this.unmount(mountPoint);
    }
  }

  async forceUnmount(mountPoint: string): Promise<void> {
    const activeMount = this.activeMounts.get(mountPoint);

    const unmountCommands = [
      ['umount', mountPoint],
      ['fusermount', '-u', mountPoint],
      ['diskutil', 'unmount', mountPoint],
      ['umount', '-f', mountPoint],
      ['fusermount', '-uz', mountPoint],
      ['diskutil', 'unmount', 'force', mountPoint],
    ];

    let success = false;
    for (const cmd of unmountCommands) {
      try {
        await this.execCommand(cmd[0]!, cmd.slice(1));
        success = true;
        break;
      } catch {
        // Try next method
      }
    }

    if (!success) {
      console.warn(`[AWCP:SSHFS] Force unmount failed for ${mountPoint}, may need manual cleanup`);
    }

    if (activeMount) {
      await this.cleanupCredentialFiles(activeMount.keyPath, activeMount.certPath);
      this.activeMounts.delete(mountPoint);
    }
  }

  private execMount(args: string[], mountPoint: string): Promise<void> {
    const timeout = this.config.mountTimeout ?? DEFAULT_MOUNT_TIMEOUT;

    return new Promise((resolve, reject) => {
      const proc = spawn('sshfs', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(async () => {
        proc.kill();
        try {
          await this.unmount(mountPoint);
        } catch {
          // Mount may not exist
        }
        reject(new SetupFailedError(`Mount timeout after ${timeout}ms`));
      }, timeout);

      proc.on('close', async (code) => {
        clearTimeout(timer);
        
        if (code !== 0) {
          reject(new SetupFailedError(stderr || `sshfs exited with code ${code}`));
          return;
        }

        // Verify mount is actually there
        try {
          const mountStat = await stat(mountPoint);
          const parentStat = await stat(join(mountPoint, '..'));
          
          if (mountStat.dev !== parentStat.dev) {
            resolve();
          } else {
            reject(new SetupFailedError('SSHFS exited but mount not detected'));
          }
        } catch (error) {
          reject(new SetupFailedError(`Mount verification failed: ${error}`));
        }
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        reject(new SetupFailedError(error.message));
      });
    });
  }

  private execCommand(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args);
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${cmd} exited with code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  }
}
