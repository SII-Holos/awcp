import { stat } from 'node:fs/promises';

/**
 * Admission control configuration
 */
export interface AdmissionConfig {
  /** Maximum total bytes allowed (default: 100MB) */
  maxTotalBytes?: number;
  /** Maximum file count allowed (default: 10000) */
  maxFileCount?: number;
  /** Maximum single file size (default: 50MB) */
  maxSingleFileBytes?: number;
  /** Custom check function */
  customCheck?: (localDir: string) => Promise<AdmissionResult>;
}

/**
 * Workspace statistics
 */
export interface WorkspaceStats {
  estimatedBytes?: number;
  fileCount?: number;
  largestFileBytes?: number;
}

/**
 * Admission check result
 */
export interface AdmissionResult {
  allowed: boolean;
  stats?: WorkspaceStats;
  hint?: string;
}

/**
 * Default thresholds
 */
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100MB
const DEFAULT_MAX_FILE_COUNT = 10000;
const DEFAULT_MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024; // 50MB

/**
 * Admission Controller
 * 
 * Performs preflight checks on workspace before allowing delegation.
 * This protects the network from being overwhelmed by large workspaces.
 */
export class AdmissionController {
  private config: AdmissionConfig;

  constructor(config?: AdmissionConfig) {
    this.config = config ?? {};
  }

  /**
   * Check if a workspace is suitable for delegation
   */
  async check(localDir: string): Promise<AdmissionResult> {
    // If custom check is provided, use it
    if (this.config.customCheck) {
      return this.config.customCheck(localDir);
    }

    try {
      const stats = await this.estimateWorkspaceStats(localDir);
      
      const maxTotal = this.config.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
      const maxCount = this.config.maxFileCount ?? DEFAULT_MAX_FILE_COUNT;
      const maxSingle = this.config.maxSingleFileBytes ?? DEFAULT_MAX_SINGLE_FILE_BYTES;

      // Check total size
      if (stats.estimatedBytes && stats.estimatedBytes > maxTotal) {
        return {
          allowed: false,
          stats,
          hint: `Workspace size (${this.formatBytes(stats.estimatedBytes)}) exceeds limit (${this.formatBytes(maxTotal)}). Consider selecting a smaller subdirectory.`,
        };
      }

      // Check file count
      if (stats.fileCount && stats.fileCount > maxCount) {
        return {
          allowed: false,
          stats,
          hint: `File count (${stats.fileCount}) exceeds limit (${maxCount}). Consider excluding node_modules, build artifacts, or data directories.`,
        };
      }

      // Check largest file
      if (stats.largestFileBytes && stats.largestFileBytes > maxSingle) {
        return {
          allowed: false,
          stats,
          hint: `Largest file (${this.formatBytes(stats.largestFileBytes)}) exceeds limit (${this.formatBytes(maxSingle)}). Consider excluding large binary files.`,
        };
      }

      return { allowed: true, stats };
    } catch (error) {
      // If we can't check, allow it (fail open for usability)
      // Real implementations may want to fail closed
      console.warn('Admission check failed, allowing by default:', error);
      return { allowed: true };
    }
  }

  /**
   * Estimate workspace statistics
   * 
   * This is a quick estimation, not an exact count.
   * For large directories, we may sample or use filesystem metadata.
   */
  private async estimateWorkspaceStats(localDir: string): Promise<WorkspaceStats> {
    // Simple implementation: just check the root directory stats
    // Real implementation would recursively scan (with limits)
    // Verify directory exists
    await stat(localDir);
    
    // For now, return basic stats
    // TODO: Implement proper recursive scanning with sampling
    return {
      estimatedBytes: undefined, // Would need recursive scan
      fileCount: undefined, // Would need recursive scan
      largestFileBytes: undefined, // Would need recursive scan
    };
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  }
}
