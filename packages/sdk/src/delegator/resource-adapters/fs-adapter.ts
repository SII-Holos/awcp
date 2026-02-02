import { mkdir, symlink, cp, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ResourceSpec } from '@awcp/core';
import type { ResourceAdapter } from './types.js';

export class FsResourceAdapter implements ResourceAdapter {
  readonly type = 'fs';

  async materialize(spec: ResourceSpec, targetPath: string): Promise<void> {
    await mkdir(dirname(targetPath), { recursive: true });
    await symlink(spec.source, targetPath);
  }

  async apply(sourcePath: string, targetPath: string): Promise<void> {
    await rm(targetPath, { recursive: true, force: true });
    await cp(sourcePath, targetPath, { recursive: true, dereference: true });
  }
}
