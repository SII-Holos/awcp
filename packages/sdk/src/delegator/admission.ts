import { stat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { WorkspaceTooLargeError, SensitiveFilesError } from '@awcp/core';
import { DEFAULT_ADMISSION } from './config.js';

/**
 * Admission control configuration
 */
export interface AdmissionConfig {
  maxTotalBytes?: number;
  maxFileCount?: number;
  maxSingleFileBytes?: number;
  sensitivePatterns?: string[];
  skipSensitiveCheck?: boolean;
}

export interface WorkspaceStats {
  estimatedBytes?: number;
  fileCount?: number;
  largestFileBytes?: number;
  sensitiveFiles?: string[];
}

/**
 * Performs preflight checks on workspace before allowing delegation.
 * Protects the system from oversized workspaces and sensitive file leaks.
 */
export class AdmissionController {
  private config: AdmissionConfig;

  constructor(config?: AdmissionConfig) {
    this.config = config ?? {};
  }

  async check(localDir: string, delegationId?: string): Promise<WorkspaceStats> {
    try {
      const stats = await this.scanWorkspace(localDir);
      
      const maxTotal = this.config.maxTotalBytes ?? DEFAULT_ADMISSION.maxTotalBytes;
      const maxCount = this.config.maxFileCount ?? DEFAULT_ADMISSION.maxFileCount;
      const maxSingle = this.config.maxSingleFileBytes ?? DEFAULT_ADMISSION.maxSingleFileBytes;

      if (stats.estimatedBytes && stats.estimatedBytes > maxTotal) {
        throw new WorkspaceTooLargeError(
          stats,
          `Workspace size (${this.formatBytes(stats.estimatedBytes)}) exceeds limit (${this.formatBytes(maxTotal)}). Consider selecting a smaller subdirectory.`,
          delegationId,
        );
      }

      if (stats.fileCount && stats.fileCount > maxCount) {
        throw new WorkspaceTooLargeError(
          stats,
          `File count (${stats.fileCount}) exceeds limit (${maxCount}). Consider excluding node_modules, build artifacts, or data directories.`,
          delegationId,
        );
      }

      if (stats.largestFileBytes && stats.largestFileBytes > maxSingle) {
        throw new WorkspaceTooLargeError(
          stats,
          `Largest file (${this.formatBytes(stats.largestFileBytes)}) exceeds limit (${this.formatBytes(maxSingle)}). Consider excluding large binary files.`,
          delegationId,
        );
      }

      const skipSensitive = this.config.skipSensitiveCheck ?? false;
      if (!skipSensitive && stats.sensitiveFiles && stats.sensitiveFiles.length > 0) {
        throw new SensitiveFilesError(stats.sensitiveFiles, undefined, delegationId);
      }

      return stats;
    } catch (error) {
      if (error instanceof WorkspaceTooLargeError || error instanceof SensitiveFilesError) throw error;
      // Fail open for usability - real implementations may want to fail closed
      console.warn('[AWCP:Admission] Check failed, allowing by default:', error);
      return {};
    }
  }

  private async scanWorkspace(localDir: string): Promise<WorkspaceStats> {
    let totalBytes = 0;
    let fileCount = 0;
    let largestFileBytes = 0;
    const sensitiveFiles: string[] = [];
    const patterns = this.config.sensitivePatterns ?? [...DEFAULT_ADMISSION.sensitivePatterns];

    const scan = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') {
            continue;
          }
          await scan(fullPath);
        } else if (entry.isFile()) {
          if (this.matchesSensitivePattern(entry.name, patterns)) {
            sensitiveFiles.push(relative(localDir, fullPath));
          }
          try {
            const fileStat = await stat(fullPath);
            const size = fileStat.size;
            totalBytes += size;
            fileCount++;
            if (size > largestFileBytes) {
              largestFileBytes = size;
            }
          } catch {
            // Skip files we can't stat (permission issues, etc.)
          }
        }
      }
    };

    await scan(localDir);

    return { estimatedBytes: totalBytes, fileCount, largestFileBytes, sensitiveFiles };
  }

  private matchesSensitivePattern(fileName: string, patterns: readonly string[]): boolean {
    for (const pattern of patterns) {
      if (this.globMatch(fileName, pattern)) return true;
    }
    return false;
  }

  private globMatch(name: string, pattern: string): boolean {
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${regex}$`).test(name);
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  }
}
