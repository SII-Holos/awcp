import type { ResourceSpec } from '@awcp/core';

export interface ResourceAdapter {
  readonly type: string;
  materialize(spec: ResourceSpec, targetPath: string): Promise<void>;
  apply(sourcePath: string, targetPath: string): Promise<void>;
}
