import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, unlink, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { MountFailedError, DependencyMissingError } from '@awcp/core';

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
  credential: string;
  mountPoint: string;
  options?: Record<string, string>;
}

/**
 * Active mount tracking
 */
interface ActiveMount {
  mountPoint: string;
  keyPath: string;
  process?: ChildProcess;
}

const DEFAULT_TEMP_KEY_DIR = '/tmp/awcp/client-keys';
const DEFAULT_MOUNT_TIMEOUT = 30000;

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
    await mkdir(tempKeyDir, { recursive: true });

    // Write credential to temp file
    const keyPath = join(tempKeyDir, `mount-${Date.now()}`);
    await writeFile(keyPath, params.credential, { mode: 0o600 });

    try {
      // Build sshfs command
      const { host, port, user } = params.endpoint;
      const remoteSpec = `${user}@${host}:${params.exportLocator}`;
      
      const options = {
        ...this.config.defaultOptions,
        ...params.options,
      };

      const args = [
        remoteSpec,
        params.mountPoint,
        '-o', `IdentityFile=${keyPath}`,
        '-o', `Port=${port}`,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'reconnect',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
      ];

      // Add custom options
      for (const [key, value] of Object.entries(options)) {
        args.push('-o', `${key}=${value}`);
      }

      // Execute mount
      await this.execMount(args, params.mountPoint);

      // Track active mount
      this.activeMounts.set(params.mountPoint, {
        mountPoint: params.mountPoint,
        keyPath,
      });

    } catch (error) {
      // Cleanup key on failure
      await unlink(keyPath).catch(() => {});
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

    // Cleanup
    if (activeMount) {
      await unlink(activeMount.keyPath).catch(() => {});
      this.activeMounts.delete(mountPoint);
    }
  }

  /**
   * Check if a mount point is currently mounted
   */
  async isMounted(mountPoint: string): Promise<boolean> {
    try {
      // Check if the mount point has the FUSE filesystem
      await access(join(mountPoint, '.'));
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

  private execMount(args: string[], _mountPoint: string): Promise<void> {
    const timeout = this.config.mountTimeout ?? DEFAULT_MOUNT_TIMEOUT;

    return new Promise((resolve, reject) => {
      const proc = spawn('sshfs', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        proc.kill();
        reject(new MountFailedError(`Mount timeout after ${timeout}ms`));
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new MountFailedError(stderr || `sshfs exited with code ${code}`));
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
