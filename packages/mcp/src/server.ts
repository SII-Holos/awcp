/**
 * AWCP MCP Server
 *
 * Provides MCP tools for AI agents to delegate workspaces to remote Executors.
 *
 * Tools:
 * - delegate: Initiate a workspace delegation
 * - delegate_output: Get delegation status/results
 * - delegate_cancel: Cancel active delegations
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DelegatorDaemonClient } from '@awcp/sdk/delegator/client';
import type { Delegation } from '@awcp/core';
import { resolve, isAbsolute } from 'node:path';

import {
  delegateSchema,
  generateDelegateDescription,
  type DelegateParams,
} from './tools/delegate.js';
import {
  delegateOutputSchema,
  delegateOutputDescription,
  type DelegateOutputParams,
} from './tools/delegate-output.js';
import {
  delegateCancelSchema,
  delegateCancelDescription,
  type DelegateCancelParams,
} from './tools/delegate-cancel.js';
import { type PeersContext } from './peer-discovery.js';

export interface AwcpMcpServerOptions {
  /** URL of the Delegator Daemon (default: http://localhost:3100) */
  daemonUrl?: string;
  /** Timeout for daemon requests in ms (default: 30000) */
  timeout?: number;
  /** Default TTL for delegations in seconds (default: 3600) */
  defaultTtl?: number;
  /** Discovered peers context (from --peers flag) */
  peers?: PeersContext;
}

/**
 * Create an AWCP MCP Server instance
 *
 * @example
 * ```typescript
 * import { createAwcpMcpServer } from '@awcp/mcp';
 * import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
 *
 * const server = createAwcpMcpServer({
 *   daemonUrl: 'http://localhost:3100',
 * });
 *
 * const transport = new StdioServerTransport();
 * await server.connect(transport);
 * ```
 */
export function createAwcpMcpServer(options: AwcpMcpServerOptions = {}) {
  const daemonUrl = options.daemonUrl ?? 'http://localhost:3100';
  const timeout = options.timeout ?? 30000;
  const defaultTtl = options.defaultTtl ?? 3600;
  const peers = options.peers;

  const client = new DelegatorDaemonClient(daemonUrl, { timeout });

  const server = new McpServer({
    name: 'awcp',
    version: '1.0.0',
  });

  // ============================================
  // Tool: delegate
  // ============================================
  server.tool(
    'delegate',
    generateDelegateDescription(peers),
    delegateSchema.shape,
    async (params: DelegateParams) => {
      const {
        description,
        prompt,
        workspace_dir,
        cwd,
        peer_url,
        ttl_seconds,
        access_mode,
        background,
      } = params;

      // Normalize workspace path: resolve relative paths against cwd
      const normalizedWorkspaceDir = isAbsolute(workspace_dir)
        ? workspace_dir
        : resolve(cwd ?? process.cwd(), workspace_dir);

      try {
        const result = await client.delegate({
          executorUrl: peer_url,
          environment: {
            resources: [{ name: 'workspace', type: 'fs', source: normalizedWorkspaceDir, mode: access_mode ?? 'rw' }],
          },
          task: { description, prompt },
          ttlSeconds: ttl_seconds ?? defaultTtl,
          accessMode: access_mode ?? 'rw',
        });

        const delegationId = result.delegationId;

        if (background) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Delegation launched in background.

Delegation ID: ${delegationId}
Executor: ${peer_url}
Workspace: ${normalizedWorkspaceDir}
Status: running

Use \`delegate_output(delegation_id="${delegationId}")\` to check progress or retrieve results.`,
              },
            ],
          };
        }

        // Sync mode: wait for completion
        const delegation = await client.waitForCompletion(delegationId, 2000, 3600000);
        return {
          content: [
            {
              type: 'text' as const,
              text: formatDelegationResult(delegation),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Delegation failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ============================================
  // Tool: delegate_output
  // ============================================
  server.tool(
    'delegate_output',
    delegateOutputDescription,
    delegateOutputSchema.shape,
    async (params: DelegateOutputParams) => {
      const { delegation_id, block, timeout: timeoutSec } = params;

      try {
        let delegation = await client.getDelegation(delegation_id);

        if (block && isRunning(delegation)) {
          const timeoutMs = (timeoutSec ?? 60) * 1000;
          delegation = await client.waitForCompletion(delegation_id, 2000, timeoutMs);
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: formatDelegationStatus(delegation),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to get delegation: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ============================================
  // Tool: delegate_cancel
  // ============================================
  server.tool(
    'delegate_cancel',
    delegateCancelDescription,
    delegateCancelSchema.shape,
    async (params: DelegateCancelParams) => {
      const { delegation_id, all } = params;

      try {
        if (all) {
          const list = await client.listDelegations();
          const active = list.delegations.filter(
            (d: { id: string; state: string }) => !['completed', 'error', 'cancelled'].includes(d.state)
          );

          for (const d of active) {
            await client.cancelDelegation(d.id);
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: `Cancelled ${active.length} delegation${active.length !== 1 ? 's' : ''}.`,
              },
            ],
          };
        }

        if (!delegation_id) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Provide either delegation_id or all=true',
              },
            ],
            isError: true,
          };
        }

        await client.cancelDelegation(delegation_id);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Delegation ${delegation_id} cancelled.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to cancel: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ============================================
// Helpers
// ============================================

function isRunning(delegation: Delegation): boolean {
  return ['created', 'invited', 'accepted', 'started', 'running'].includes(
    delegation.state
  );
}

function formatDelegationResult(delegation: Delegation): string {
  const lines: string[] = [
    `Delegation: ${delegation.id}`,
    `Status: ${delegation.state}`,
  ];

  if (delegation.state === 'completed' && delegation.result) {
    lines.push('', '--- Result ---', delegation.result.summary);
    if (delegation.result.highlights?.length) {
      lines.push('', 'Highlights:', ...delegation.result.highlights.map((h: string) => `  - ${h}`));
    }
  }

  if (delegation.state === 'error' && delegation.error) {
    lines.push('', '--- Error ---', delegation.error.message);
    if (delegation.error.hint) {
      lines.push(`Hint: ${delegation.error.hint}`);
    }
  }

  return lines.join('\n');
}

function formatDelegationStatus(delegation: Delegation): string {
  const lines: string[] = [
    `Delegation: ${delegation.id}`,
    `Status: ${delegation.state}`,
    `Executor: ${delegation.peerUrl}`,
    `Created: ${delegation.createdAt}`,
  ];

  if (isRunning(delegation)) {
    lines.push('', 'Task is still running...');
  } else if (delegation.state === 'completed' && delegation.result) {
    lines.push('', '--- Result ---', delegation.result.summary);
  } else if (delegation.state === 'error' && delegation.error) {
    lines.push('', '--- Error ---', delegation.error.message);
    if (delegation.error.hint) {
      lines.push(`Hint: ${delegation.error.hint}`);
    }
  } else if (delegation.state === 'cancelled') {
    lines.push('', 'Delegation was cancelled.');
  }

  return lines.join('\n');
}

export { DelegatorDaemonClient } from '@awcp/sdk/delegator/client';
