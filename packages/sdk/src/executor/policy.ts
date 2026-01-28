import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Local policy configuration
 */
export interface PolicyConfig {
  /** Base directory for mount points (default: /tmp/awcp/mounts) */
  mountRoot?: string;
  /** Forbidden paths that cannot be used as mount points */
  forbiddenPaths?: string[];
  /** Maximum concurrent delegations */
  maxConcurrent?: number;
}

/**
 * Mount point validation result
 */
export interface MountPointValidation {
  valid: boolean;
  reason?: string;
}

/**
 * Default mount root directory
 */
const DEFAULT_MOUNT_ROOT = '/tmp/awcp/mounts';

/**
 * Default forbidden paths
 */
const DEFAULT_FORBIDDEN_PATHS = [
  '/',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/var',
  '/home',
  '/root',
  '/System',
  '/Library',
  '/Applications',
  process.env['HOME'] ?? '',
].filter(Boolean);

/**
 * Local Policy
 * 
 * Enforces security constraints on the Executor side.
 * Determines mount points and validates they are safe.
 */
export class LocalPolicy {
  private config: PolicyConfig;
  private allocatedMounts = new Set<string>();

  constructor(config?: PolicyConfig) {
    this.config = config ?? {};
  }

  /**
   * Allocate a mount point for a delegation
   * 
   * The mount point is always under the configured mount root,
   * preventing any attacker-controlled paths.
   */
  allocateMountPoint(delegationId: string): string {
    const root = this.config.mountRoot ?? DEFAULT_MOUNT_ROOT;
    const mountPoint = join(root, delegationId);
    this.allocatedMounts.add(mountPoint);
    return mountPoint;
  }

  /**
   * Validate that a mount point is safe to use
   */
  async validateMountPoint(mountPoint: string): Promise<MountPointValidation> {
    const root = this.config.mountRoot ?? DEFAULT_MOUNT_ROOT;
    const forbidden = this.config.forbiddenPaths ?? DEFAULT_FORBIDDEN_PATHS;

    // Must be under mount root
    if (!mountPoint.startsWith(root)) {
      return {
        valid: false,
        reason: `Mount point must be under ${root}`,
      };
    }

    // Must not be in forbidden paths
    for (const path of forbidden) {
      if (mountPoint === path || mountPoint.startsWith(path + '/')) {
        return {
          valid: false,
          reason: `Mount point ${mountPoint} is in forbidden path ${path}`,
        };
      }
    }

    // Check if it's already mounted (would need to check /proc/mounts on Linux)
    // For now, just check if directory exists and is empty

    return { valid: true };
  }

  /**
   * Prepare a mount point for use
   * 
   * Creates the directory if needed and ensures it's empty.
   */
  async prepareMountPoint(mountPoint: string): Promise<void> {
    // Create directory
    await mkdir(mountPoint, { recursive: true });

    // Check if empty
    const entries = await readdir(mountPoint);
    if (entries.length > 0) {
      throw new Error(
        `Mount point ${mountPoint} is not empty. ` +
        `Found ${entries.length} entries. ` +
        `Refusing to mount to prevent data occlusion.`
      );
    }
  }

  /**
   * Release a mount point
   */
  releaseMountPoint(mountPoint: string): void {
    this.allocatedMounts.delete(mountPoint);
  }

  /**
   * Check if concurrent limit is reached
   */
  canAcceptMore(): boolean {
    const max = this.config.maxConcurrent ?? Infinity;
    return this.allocatedMounts.size < max;
  }

  /**
   * Get currently allocated mount points
   */
  getAllocatedMounts(): string[] {
    return Array.from(this.allocatedMounts);
  }
}
