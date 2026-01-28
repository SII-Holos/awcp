import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Export view configuration
 */
export interface ExportConfig {
  /** Base directory for export views (default: /tmp/awcp/exports) */
  baseDir?: string;
  /** Strategy for creating export view */
  strategy?: 'symlink' | 'bind' | 'worktree';
}

/**
 * Default export base directory
 */
const DEFAULT_EXPORT_BASE = '/tmp/awcp/exports';

/**
 * Export View Manager
 * 
 * Creates isolated export views for each delegation.
 * This prevents exposing real paths and enables cleanup.
 */
export class ExportViewManager {
  private config: ExportConfig;
  private exports = new Map<string, string>();

  constructor(config?: ExportConfig) {
    this.config = config ?? {};
  }

  /**
   * Create an export view for a delegation
   * 
   * @returns The path to the export view
   */
  async create(delegationId: string, localDir: string): Promise<string> {
    const baseDir = this.config.baseDir ?? DEFAULT_EXPORT_BASE;
    const exportPath = join(baseDir, delegationId, 'workspace');

    // Create export directory structure
    await mkdir(join(baseDir, delegationId), { recursive: true });

    // Create the export view based on strategy
    const strategy = this.config.strategy ?? 'symlink';
    
    switch (strategy) {
      case 'symlink':
        // Simple symlink (not recommended for production)
        await symlink(localDir, exportPath);
        break;
      
      case 'bind':
        // Bind mount - requires root/sudo
        // Would use: mount --bind <localDir> <exportPath>
        // For now, fall back to symlink
        console.warn('Bind mount not implemented, falling back to symlink');
        await symlink(localDir, exportPath);
        break;
      
      case 'worktree':
        // Git worktree - requires git repo
        // Would use: git worktree add <exportPath>
        // For now, fall back to symlink
        console.warn('Git worktree not implemented, falling back to symlink');
        await symlink(localDir, exportPath);
        break;
    }

    this.exports.set(delegationId, exportPath);
    return exportPath;
  }

  /**
   * Cleanup an export view
   */
  async cleanup(delegationId: string): Promise<void> {
    const exportPath = this.exports.get(delegationId);
    if (!exportPath) {
      return;
    }

    try {
      const baseDir = this.config.baseDir ?? DEFAULT_EXPORT_BASE;
      const delegationDir = join(baseDir, delegationId);
      
      // Remove the entire delegation directory
      await rm(delegationDir, { recursive: true, force: true });
      
      this.exports.delete(delegationId);
    } catch (error) {
      console.error(`Failed to cleanup export view for ${delegationId}:`, error);
    }
  }

  /**
   * Get the export path for a delegation
   */
  getExportPath(delegationId: string): string | undefined {
    return this.exports.get(delegationId);
  }

  /**
   * Cleanup all export views
   */
  async cleanupAll(): Promise<void> {
    for (const delegationId of this.exports.keys()) {
      await this.cleanup(delegationId);
    }
  }
}
