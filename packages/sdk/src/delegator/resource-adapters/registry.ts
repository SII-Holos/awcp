import type { ResourceAdapter } from './types.js';

export class ResourceAdapterRegistry {
  private adapters = new Map<string, ResourceAdapter>();

  register(adapter: ResourceAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  get(type: string): ResourceAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`Unknown resource type: ${type}`);
    }
    return adapter;
  }

  has(type: string): boolean {
    return this.adapters.has(type);
  }
}
