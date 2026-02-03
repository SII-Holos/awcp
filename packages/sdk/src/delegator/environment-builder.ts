/**
 * Environment Builder - builds environment directories for delegation
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EnvironmentSpec } from '@awcp/core';
import { ResourceAdapterRegistry, FsResourceAdapter } from './resource-adapters/index.js';
import { cleanupStaleDirectories } from '../utils/index.js';

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
   * Returns envRoot with trailing slash for SSHFS compatibility.
   */
  async build(delegationId: string, spec: EnvironmentSpec): Promise<EnvironmentBuildResult> {
    const envRoot = join(this.baseDir, delegationId);
    await mkdir(envRoot, { recursive: true });

    for (const resource of spec.resources) {
      const targetPath = join(envRoot, resource.name);
      const adapter = this.adapters.get(resource.type);
      await adapter.materialize(resource, targetPath);
    }

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

    const result = { envRoot: `${envRoot}/`, manifest };
    this.environments.set(delegationId, result);
    return result;
  }

  get(delegationId: string): EnvironmentBuildResult | undefined {
    return this.environments.get(delegationId);
  }

  async release(delegationId: string): Promise<void> {
    const env = this.environments.get(delegationId);
    if (!env) return;

    try {
      await rm(env.envRoot, { recursive: true, force: true });
    } catch {
      // Directory may already be removed
    }
    this.environments.delete(delegationId);
  }

  async cleanupStale(): Promise<number> {
    return cleanupStaleDirectories(this.baseDir, new Set(this.environments.keys()));
  }
}
