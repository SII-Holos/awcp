/**
 * Delegator Daemon Client
 *
 * HTTP client for interacting with a running Delegator Daemon.
 * Use this from MCP servers, CLI tools, or other applications.
 *
 * @example
 * ```typescript
 * import { DelegatorDaemonClient } from '@awcp/sdk/delegator/bin/client';
 *
 * const client = new DelegatorDaemonClient('http://localhost:3100');
 *
 * // Create delegation
 * const result = await client.delegate({
 *   executorUrl: 'http://executor:4001/awcp',
 *   environment: {
 *     resources: [{ name: 'project', type: 'fs', source: '/path/to/project', mode: 'rw' }]
 *   },
 *   task: { description: 'Fix bug', prompt: '...' },
 * });
 *
 * // Check status
 * const delegation = await client.getDelegation(result.delegationId);
 *
 * // List all
 * const all = await client.listDelegations();
 * ```
 */

import type { Delegation, TaskSpec, AccessMode, AuthCredential, EnvironmentSpec, EnvironmentSnapshot, SnapshotPolicy } from '@awcp/core';

/**
 * Parameters for creating a delegation
 */
export interface DelegateRequest {
  /** URL of the Executor's AWCP endpoint */
  executorUrl: string;
  /** Environment specification with resources to delegate */
  environment: EnvironmentSpec;
  /** Task specification */
  task: TaskSpec;
  /** TTL in seconds (uses default if not specified) */
  ttlSeconds?: number;
  /** Access mode (uses default if not specified) */
  accessMode?: AccessMode;
  /** Snapshot handling mode */
  snapshotMode?: SnapshotPolicy;
  /** Optional authentication for paid/restricted Executor services */
  auth?: AuthCredential;
}

/**
 * Response from creating a delegation
 */
export interface DelegateResponse {
  delegationId: string;
}

/**
 * List delegations response
 */
export interface ListDelegationsResponse {
  activeDelegations: number;
  delegations: Array<{
    id: string;
    state: string;
    executorUrl: string;
    environment: EnvironmentSpec;
    createdAt: string;
  }>;
}

/**
 * HTTP client for Delegator Daemon
 */
export class DelegatorDaemonClient {
  private baseUrl: string;
  private timeout: number;

  constructor(daemonUrl: string, options?: { timeout?: number }) {
    this.baseUrl = daemonUrl.replace(/\/$/, '');
    this.timeout = options?.timeout ?? 30000;
  }

  /**
   * Create a new delegation
   */
  async delegate(params: DelegateRequest): Promise<DelegateResponse> {
    const response = await this.request<DelegateResponse>('/delegate', {
      method: 'POST',
      body: params,
    });
    return response;
  }

  /**
   * Get a delegation by ID
   */
  async getDelegation(delegationId: string): Promise<Delegation> {
    return this.request<Delegation>(`/delegation/${delegationId}`);
  }

  /**
   * List all delegations
   */
  async listDelegations(): Promise<ListDelegationsResponse> {
    return this.request<ListDelegationsResponse>('/delegations');
  }

  /**
   * Cancel a delegation
   */
  async cancelDelegation(delegationId: string): Promise<void> {
    await this.request(`/delegation/${delegationId}`, { method: 'DELETE' });
  }

  /**
   * Wait for a delegation to complete
   */
  async waitForCompletion(
    delegationId: string,
    pollIntervalMs: number = 1000,
    timeoutMs: number = 60000
  ): Promise<Delegation> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const delegation = await this.getDelegation(delegationId);

      if (
        delegation.state === 'completed' ||
        delegation.state === 'error' ||
        delegation.state === 'cancelled'
      ) {
        return delegation;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Timeout waiting for delegation ${delegationId} to complete`);
  }

  /**
   * List snapshots for a delegation
   */
  async listSnapshots(delegationId: string): Promise<EnvironmentSnapshot[]> {
    const response = await this.request<{ snapshots: EnvironmentSnapshot[] }>(
      `/delegation/${delegationId}/snapshots`
    );
    return response.snapshots;
  }

  /**
   * Apply a snapshot to the local workspace
   */
  async applySnapshot(delegationId: string, snapshotId: string): Promise<void> {
    await this.request(`/delegation/${delegationId}/snapshots/${snapshotId}/apply`, {
      method: 'POST',
    });
  }

  /**
   * Discard a snapshot without applying
   */
  async discardSnapshot(delegationId: string, snapshotId: string): Promise<void> {
    await this.request(`/delegation/${delegationId}/snapshots/${snapshotId}/discard`, {
      method: 'POST',
    });
  }

  /**
   * Health check
   */
  async health(): Promise<boolean> {
    try {
      await this.request('/health');
      return true;
    } catch {
      return false;
    }
  }

  private async request<T>(path: string, options?: {
    method?: string;
    body?: unknown;
  }): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options?.method ?? 'GET',
        headers: options?.body ? { 'Content-Type': 'application/json' } : {},
        body: options?.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({})) as { 
          error?: string; 
          hint?: string;
          code?: string;
          knownDelegations?: number;
        };
        const message = errorBody.error ?? `HTTP ${response.status}: ${response.statusText}`;
        const parts = [message];
        if (errorBody.hint) parts.push(`Hint: ${errorBody.hint}`);
        if (errorBody.knownDelegations !== undefined) parts.push(`Known delegations: ${errorBody.knownDelegations}`);
        throw new Error(parts.join('. '));
      }

      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
