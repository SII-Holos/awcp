/**
 * Environment Builder - builds environment directories for delegation
 */

import { mkdir, rm, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EnvironmentSpec } from '@awcp/core';
import { ResourceAdapterRegistry, FsResourceAdapter } from './resource-adapters/index.js';

const DEFAULT_ENV_BASE = '/tmp/awcp/environments';

export interface EnvironmentManifest {
  version: '1';
  delegationId: string;
  createdAt: string;
  resources: Array<{
    name: string;
    type: string;
    source: string;
    mode: 'ro' | 'rw';
  }>;
}

export interface EnvironmentBuildResult {
  envRoot: string;
  manifest: EnvironmentManifest;
}

export interface EnvironmentBuilderConfig {
  baseDir?: string;
}

/**
 * Builds and manages environment directories for delegations.
 */
export class EnvironmentBuilder {
  private baseDir: string;
  private adapters: ResourceAdapterRegistry;
  private environments = new Map<string, EnvironmentBuildResult>();

  constructor(config?: EnvironmentBuilderConfig) {
    this.baseDir = config?.baseDir ?? DEFAULT_ENV_BASE;
    this.adapters = new ResourceAdapterRegistry();
    this.adapters.register(new FsResourceAdapter());
  }

  /**
   * Build an environment directory from spec.
   * Returns path with trailing slash for SSHFS compatibility.
   */
  async build(delegationId: string, spec: EnvironmentSpec): Promise<EnvironmentBuildResult> {
    const envRoot = join(this.baseDir, delegationId);
    await mkdir(envRoot, { recursive: true });

    // Materialize each resource
    for (const resource of spec.resources) {
      const targetPath = join(envRoot, resource.name);
      const adapter = this.adapters.get(resource.type);
      await adapter.materialize(resource, targetPath);
    }

    // Write manifest (excluded from transport)
    const manifest: EnvironmentManifest = {
      version: '1',
      delegationId,
      createdAt: new Date().toISOString(),
      resources: spec.resources.map(r => ({
        name: r.name,
        type: r.type,
        source: r.source,
        mode: r.mode,
      })),
    };

    const awcpDir = join(envRoot, '.awcp');
    await mkdir(awcpDir, { recursive: true });
    await writeFile(join(awcpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const result = { envRoot: envRoot + '/', manifest };
    this.environments.set(delegationId, result);
    return result;
  }

  /** Get environment info for a delegation */
  get(delegationId: string): EnvironmentBuildResult | undefined {
    return this.environments.get(delegationId);
  }

  /** Release an environment directory */
  async release(delegationId: string): Promise<void> {
    const env = this.environments.get(delegationId);
    if (!env) return;

    try {
      await rm(env.envRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    this.environments.delete(delegationId);
  }

  /** Apply result back to original paths */
  async applyResult(delegationId: string, resultEnvRoot: string): Promise<void> {
    const env = this.environments.get(delegationId);
    if (!env) {
      throw new Error(`No environment found for delegation ${delegationId}`);
    }

    for (const resource of env.manifest.resources) {
      if (resource.mode === 'rw') {
        const sourcePath = join(resultEnvRoot, resource.name);
        const targetPath = resource.source;
        const adapter = this.adapters.get(resource.type);
        await adapter.apply(sourcePath, targetPath);
      }
    }
  }

  /** Cleanup stale environment directories from previous runs */
  async cleanupStale(): Promise<number> {
    let cleaned = 0;
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !this.environments.has(entry.name)) {
          await rm(join(this.baseDir, entry.name), { recursive: true, force: true });
          cleaned++;
        }
      }
    } catch {
      // Base directory may not exist yet
    }
    return cleaned;
  }
}
