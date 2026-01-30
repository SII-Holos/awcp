import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, unlink, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MountFailedError, DependencyMissingError, type SshCredential } from '@awcp/core';

/**
 * SSHFS Mount Client configuration
 */
export interface SshfsMountConfig {
  /** Directory to store temporary key files */
  tempKeyDir?: string;
  /** Additional sshfs options */
  defaultOptions?: Record<string, string>;
  /** Timeout for mount operation in ms (default: 30000) */
  mountTimeout?: number;
}

/**
 * Mount parameters
 */
export interface MountParams {
  endpoint: {
    host: string;
    port: number;
    user: string;
  };
  exportLocator: string;
  credential: SshCredential;
  mountPoint: string;
  options?: Record<string, string>;
}

/**
 * Active mount tracking
 */
export interface ActiveMount {
  mountPoint: string;
  keyPath: string;
  certPath: string;
  process?: ChildProcess;
}

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
  ];

  for (const [key, value] of Object.entries(options)) {
    args.push('-o', `${key}=${value}`);
  }

  return args;
}

/**
 * SSHFS Mount Client
 * 
 * Handles mounting remote filesystems via SSHFS on the Remote side.
 */
export class SshfsMountClient {
  private config: SshfsMountConfig;
  private activeMounts = new Map<string, ActiveMount>();

  constructor(config?: SshfsMountConfig) {
    this.config = config ?? {};
  }

  /**
   * Get active mounts (for testing)
   */
  getActiveMounts(): Map<string, ActiveMount> {
    return this.activeMounts;
  }

  /**
   * Check if sshfs is available
   */
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

  /**
   * Write credential files to disk
   */
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

  /**
   * Clean up credential files
   */
  async cleanupCredentialFiles(keyPath: string, certPath: string): Promise<void> {
    await unlink(keyPath).catch(() => {});
    await unlink(certPath).catch(() => {});
  }

  /**
   * Mount a remote filesystem
   */
  async mount(params: MountParams): Promise<void> {
    // Check dependency
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

      console.log(`[SSHFS] Mounting: sshfs ${args.join(' ')}`);

      // Execute mount (SSHFS will daemonize and exit immediately on success)
      await this.execMount(args, params.mountPoint);

      // Track active mount
      this.activeMounts.set(params.mountPoint, {
        mountPoint: params.mountPoint,
        keyPath,
        certPath,
      });

    } catch (error) {
      // Cleanup key and cert on failure
      await this.cleanupCredentialFiles(keyPath, certPath);
      throw error;
    }
  }

  /**
   * Unmount a filesystem
   */
  async unmount(mountPoint: string): Promise<void> {
    const activeMount = this.activeMounts.get(mountPoint);

    // Try different unmount methods
    const unmountCommands = [
      ['umount', mountPoint],
      ['fusermount', '-u', mountPoint],
      ['diskutil', 'unmount', mountPoint], // macOS
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
      console.warn(`Failed to unmount ${mountPoint}, may need manual cleanup`);
    }

    // Cleanup key and certificate files
    if (activeMount) {
      await this.cleanupCredentialFiles(activeMount.keyPath, activeMount.certPath);
      this.activeMounts.delete(mountPoint);
    }
  }

  /**
   * Check if a mount point is currently mounted
   */
  async isMounted(mountPoint: string): Promise<boolean> {
    try {
      // Check if the mount point exists and is tracked
      await stat(mountPoint);
      return this.activeMounts.has(mountPoint);
    } catch {
      return false;
    }
  }

  /**
   * Unmount all active mounts
   */
  async unmountAll(): Promise<void> {
    for (const mountPoint of this.activeMounts.keys()) {
      await this.unmount(mountPoint);
    }
  }

  private execMount(args: string[], mountPoint: string): Promise<void> {
    const timeout = this.config.mountTimeout ?? DEFAULT_MOUNT_TIMEOUT;

    return new Promise((resolve, reject) => {
      // SSHFS without -f will daemonize and exit immediately with code 0 on success
      const proc = spawn('sshfs', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(async () => {
        proc.kill();
        // Clean up possible zombie mount
        try {
          await this.unmount(mountPoint);
        } catch {
          // Ignore - mount may not exist
        }
        reject(new MountFailedError(`Mount timeout after ${timeout}ms`));
      }, timeout);

      proc.on('close', async (code) => {
        clearTimeout(timer);
        
        if (code !== 0) {
          reject(new MountFailedError(stderr || `sshfs exited with code ${code}`));
          return;
        }

        // SSHFS daemonized successfully (exit code 0)
        // Now verify the mount is actually there
        try {
          const mountStat = await stat(mountPoint);
          const parentStat = await stat(join(mountPoint, '..'));
          
          if (mountStat.dev !== parentStat.dev) {
            // Different device = mounted successfully
            resolve();
          } else {
            reject(new MountFailedError('SSHFS exited but mount not detected'));
          }
        } catch (error) {
          reject(new MountFailedError(`Mount verification failed: ${error}`));
        }
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        reject(new MountFailedError(error.message));
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
