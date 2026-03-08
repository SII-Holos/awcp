/**
 * AWCP MCP Server
 *
 * Provides MCP tools for AI agents to delegate workspaces to remote Executors.
 *
 * Tools:
 * - delegate: Initiate a workspace delegation
 * - delegate_output: Get delegation status/results
 * - delegate_cancel: Cancel active delegations
 * - delegate_continue: Send new instructions to an idle delegation (multi-round)
 * - delegate_close: End a multi-round delegation session
 * - delegate_snapshots: List snapshots for a delegation
 * - delegate_apply_snapshot: Apply a staged snapshot
 * - delegate_discard_snapshot: Discard a staged snapshot
 * - delegate_recover: Recover results after connection loss
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DelegatorDaemonClient } from '@awcp/sdk/delegator/client';
import type { Delegation, SnapshotMode, AuthCredential } from '@awcp/core';
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
import {
  delegateSnapshotsSchema,
  delegateSnapshotsDescription,
  type DelegateSnapshotsParams,
} from './tools/delegate-snapshots.js';
import {
  delegateApplySnapshotSchema,
  delegateApplySnapshotDescription,
  type DelegateApplySnapshotParams,
} from './tools/delegate-apply-snapshot.js';
import {
  delegateDiscardSnapshotSchema,
  delegateDiscardSnapshotDescription,
  type DelegateDiscardSnapshotParams,
} from './tools/delegate-discard-snapshot.js';
import {
  delegateRecoverSchema,
  delegateRecoverDescription,
  type DelegateRecoverParams,
} from './tools/delegate-recover.js';
import {
  delegateContinueSchema,
  delegateContinueDescription,
  type DelegateContinueParams,
} from './tools/delegate-continue.js';
import {
  delegateCloseSchema,
  delegateCloseDescription,
  type DelegateCloseParams,
} from './tools/delegate-close.js';
import { type PeersContext } from './peer-discovery.js';

export interface AwcpMcpServerOptions {
  daemonUrl?: string;
  timeout?: number;
  defaultTtl?: number;
  defaultSnapshotMode?: SnapshotMode;
  peers?: PeersContext;
}

export function createAwcpMcpServer(options: AwcpMcpServerOptions = {}) {
  const daemonUrl = options.daemonUrl ?? 'http://localhost:3100';
  const timeout = options.timeout ?? 30000;
  const defaultTtl = options.defaultTtl ?? 3600;
  const defaultSnapshotMode = options.defaultSnapshotMode ?? 'auto';
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
        resources,
        cwd,
        peer_url,
        ttl_seconds,
        access_mode,
        snapshot_mode,
        auth_type,
        auth_credential,
        background,
      } = params;

      // Build resources list
      const resourceList = buildResourceList(workspace_dir, resources, access_mode, cwd);
      if (!resourceList.length) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Either workspace_dir or resources must be provided',
          }],
          isError: true,
        };
      }

      // Build auth if provided
      const auth: AuthCredential | undefined = auth_type && auth_credential
        ? { type: auth_type, credential: auth_credential }
        : undefined;

      try {
        const result = await client.delegate({
          executorUrl: peer_url,
          environment: { resources: resourceList },
          task: { description, prompt },
          ttlSeconds: ttl_seconds ?? defaultTtl,
          accessMode: access_mode ?? 'rw',
          snapshotMode: snapshot_mode ?? defaultSnapshotMode,
          auth,
        });

        const delegationId = result.delegationId;

        if (background) {
          const snapshotNote = (snapshot_mode ?? defaultSnapshotMode) === 'staged'
            ? '\nSnapshot mode: staged (use delegate_snapshots to review, delegate_apply_snapshot to apply)'
            : '';

          return {
            content: [{
              type: 'text' as const,
              text: `Delegation launched in background.

Delegation ID: ${delegationId}
Executor: ${peer_url}
Resources: ${resourceList.map(r => r.name).join(', ')}
Status: running${snapshotNote}

Use \`delegate_output(delegation_id="${delegationId}")\` to check progress or retrieve results.`,
            }],
          };
        }

        const delegation = await client.waitForCompletion(delegationId, 2000, 3600000);
        return {
          content: [{
            type: 'text' as const,
            text: formatDelegationResult(delegation),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Delegation failed: ${error instanceof Error ? error.message : String(error)}`,
          }],
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
          delegation = await client.waitForIdle(delegation_id, 2000, timeoutMs);
        }

        return {
          content: [{
            type: 'text' as const,
            text: formatDelegationStatus(delegation),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Failed to get delegation: ${error instanceof Error ? error.message : String(error)}`,
          }],
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
            (d: { id: string; state: string }) => !isTerminalState(d.state)
          );

          for (const d of active) {
            await client.cancelDelegation(d.id);
          }

          return {
            content: [{
              type: 'text' as const,
              text: `Cancelled ${active.length} delegation${active.length !== 1 ? 's' : ''}.`,
            }],
          };
        }

        if (!delegation_id) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Provide either delegation_id or all=true',
            }],
            isError: true,
          };
        }

        await client.cancelDelegation(delegation_id);
        return {
          content: [{
            type: 'text' as const,
            text: `Delegation ${delegation_id} cancelled.`,
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Failed to cancel: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ============================================
  // Tool: delegate_snapshots
  // ============================================
  server.tool(
    'delegate_snapshots',
    delegateSnapshotsDescription,
    delegateSnapshotsSchema.shape,
    async (params: DelegateSnapshotsParams) => {
      const { delegation_id } = params;

      try {
        const snapshots = await client.listSnapshots(delegation_id);

        if (snapshots.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No snapshots for delegation ${delegation_id}`,
            }],
          };
        }

        const lines = snapshots.map(s => {
          const status = s.status === 'applied' ? '✓ applied'
            : s.status === 'discarded' ? '✗ discarded'
            : '○ pending';
          const rec = s.recommended ? ' (recommended)' : '';
          const meta = s.metadata
            ? ` [${s.metadata.fileCount ?? '?'} files, ${formatBytes(s.metadata.totalBytes)}]`
            : '';
          return `- ${s.id}: ${s.summary}${rec}\n  Status: ${status}${meta}`;
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Snapshots for ${delegation_id}:\n\n${lines.join('\n\n')}`,
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Failed to list snapshots: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ============================================
  // Tool: delegate_apply_snapshot
  // ============================================
  server.tool(
    'delegate_apply_snapshot',
    delegateApplySnapshotDescription,
    delegateApplySnapshotSchema.shape,
    async (params: DelegateApplySnapshotParams) => {
      const { delegation_id, snapshot_id } = params;

      try {
        const beforeState = (await client.getDelegation(delegation_id))?.state;
        await client.applySnapshot(delegation_id, snapshot_id);

        if (beforeState === 'idle') {
          return {
            content: [{
              type: 'text' as const,
              text: `Snapshot ${snapshot_id} applied successfully. Local workspace updated.\nDelegation auto-closed (session ended).`,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Snapshot ${snapshot_id} applied successfully. Local workspace updated.`,
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Failed to apply snapshot: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ============================================
  // Tool: delegate_discard_snapshot
  // ============================================
  server.tool(
    'delegate_discard_snapshot',
    delegateDiscardSnapshotDescription,
    delegateDiscardSnapshotSchema.shape,
    async (params: DelegateDiscardSnapshotParams) => {
      const { delegation_id, snapshot_id } = params;

      try {
        await client.discardSnapshot(delegation_id, snapshot_id);
        return {
          content: [{
            type: 'text' as const,
            text: `Snapshot ${snapshot_id} discarded.`,
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Failed to discard snapshot: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ============================================
  // Tool: delegate_recover
  // ============================================
  server.tool(
    'delegate_recover',
    delegateRecoverDescription,
    delegateRecoverSchema.shape,
    async (params: DelegateRecoverParams) => {
      // TODO: Implement when ExecutorClient.fetchResult is integrated into DelegatorService
      const { delegation_id, peer_url } = params;

      return {
        content: [{
          type: 'text' as const,
          text: `Recovery not yet implemented. Delegation: ${delegation_id}, Executor: ${peer_url}`,
        }],
        isError: true,
      };
    }
  );

  // ============================================
  // Tool: delegate_continue
  // ============================================
  server.tool(
    'delegate_continue',
    delegateContinueDescription,
    delegateContinueSchema.shape,
    async (params: DelegateContinueParams) => {
      const { delegation_id, description, prompt, background } = params;

      try {
        await client.continueDelegation(delegation_id, { description, prompt });

        if (background) {
          return {
            content: [{
              type: 'text' as const,
              text: `Continuation round started in background.

Delegation ID: ${delegation_id}
Task: ${description}
Status: running

Use \`delegate_output(delegation_id="${delegation_id}")\` to check progress.`,
            }],
          };
        }

        const delegation = await client.waitForIdle(delegation_id, 2000, 3600000);

        if (delegation.state === 'idle') {
          return {
            content: [{
              type: 'text' as const,
              text: formatRoundResult(delegation),
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: formatDelegationResult(delegation),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Continue failed: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ============================================
  // Tool: delegate_close
  // ============================================
  server.tool(
    'delegate_close',
    delegateCloseDescription,
    delegateCloseSchema.shape,
    async (params: DelegateCloseParams) => {
      const { delegation_id } = params;

      try {
        await client.closeDelegation(delegation_id);
        return {
          content: [{
            type: 'text' as const,
            text: `Delegation ${delegation_id} closed. Workspace and transport cleaned up.`,
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Close failed: ${error instanceof Error ? error.message : String(error)}`,
          }],
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

function buildResourceList(
  workspaceDir: string | undefined,
  resources: Array<{ name: string; path: string; mode?: 'ro' | 'rw' }> | undefined,
  defaultMode: 'ro' | 'rw' | undefined,
  cwd: string | undefined
): Array<{ name: string; type: 'fs'; source: string; mode: 'ro' | 'rw' }> {
  const resolveDir = (dir: string) => isAbsolute(dir) ? dir : resolve(cwd ?? process.cwd(), dir);

  if (resources && resources.length > 0) {
    return resources.map(r => ({
      name: r.name,
      type: 'fs' as const,
      source: resolveDir(r.path),
      mode: r.mode ?? defaultMode ?? 'rw',
    }));
  }

  if (workspaceDir) {
    return [{
      name: 'workspace',
      type: 'fs' as const,
      source: resolveDir(workspaceDir),
      mode: defaultMode ?? 'rw',
    }];
  }

  return [];
}

function isTerminalState(state: string): boolean {
  return ['completed', 'error', 'cancelled', 'expired'].includes(state);
}

function isRunning(delegation: Delegation): boolean {
  return !isTerminalState(delegation.state) && delegation.state !== 'idle';
}

function formatRoundResult(delegation: Delegation): string {
  const lastRound = delegation.rounds?.[delegation.rounds.length - 1];
  const lines: string[] = [
    `Delegation: ${delegation.id}`,
    `Status: idle (round ${delegation.currentRound} complete)`,
  ];

  if (lastRound?.result) {
    lines.push('', '--- Round Result ---', lastRound.result.summary);
    if (lastRound.result.highlights?.length) {
      lines.push('', 'Highlights:', ...lastRound.result.highlights.map(h => `  - ${h}`));
    }
  }

  const pendingSnapshots = delegation.snapshots?.filter(s => s.status === 'pending') ?? [];
  if (pendingSnapshots.length > 0) {
    lines.push('', `${pendingSnapshots.length} pending snapshot(s) - use delegate_snapshots to review`);
  }

  lines.push('', 'Next steps:');
  lines.push(`  - delegate_continue(delegation_id="${delegation.id}", ...) to iterate further`);
  lines.push(`  - delegate_close(delegation_id="${delegation.id}") to end the session`);

  return lines.join('\n');
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '? bytes';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDelegationResult(delegation: Delegation): string {
  const lines: string[] = [
    `Delegation: ${delegation.id}`,
    `Status: ${delegation.state}`,
  ];

  if (delegation.rounds?.length > 1) {
    lines.push(`Rounds completed: ${delegation.rounds.length}`);
  }

  if (delegation.state === 'completed' && delegation.result) {
    lines.push('', '--- Result ---', delegation.result.summary);
    if (delegation.result.highlights?.length) {
      lines.push('', 'Highlights:', ...delegation.result.highlights.map((h: string) => `  - ${h}`));
    }

    if (delegation.rounds?.length > 1) {
      lines.push('', '--- Round History ---');
      for (const round of delegation.rounds) {
        const roundResult = round.result?.summary ?? '(no result)';
        lines.push(`  Round ${round.number}: ${roundResult}`);
      }
    }

    const pendingSnapshots = delegation.snapshots?.filter(s => s.status === 'pending') ?? [];
    if (pendingSnapshots.length > 0) {
      lines.push('', `${pendingSnapshots.length} pending snapshot(s) - use delegate_snapshots to review`);
    }
  }

  if (delegation.state === 'error' && delegation.error) {
    lines.push('', '--- Error ---');
    lines.push(`Code: ${delegation.error.code}`);
    lines.push(`Message: ${delegation.error.message}`);
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

  if (delegation.currentRound > 1 || delegation.state === 'idle') {
    lines.push(`Current round: ${delegation.currentRound}`);
  }

  if (delegation.snapshotPolicy) {
    lines.push(`Snapshot mode: ${delegation.snapshotPolicy.mode}`);
  }

  if (delegation.snapshots?.length) {
    const applied = delegation.snapshots.filter(s => s.status === 'applied').length;
    const pending = delegation.snapshots.filter(s => s.status === 'pending').length;
    const discarded = delegation.snapshots.filter(s => s.status === 'discarded').length;
    lines.push(`Snapshots: ${delegation.snapshots.length} total (${applied} applied, ${pending} pending, ${discarded} discarded)`);
  }

  if (delegation.state === 'idle') {
    const lastRound = delegation.rounds?.[delegation.rounds.length - 1];
    lines.push('', 'Round complete — delegation is idle, awaiting next action.');
    if (lastRound?.result) {
      lines.push('', `--- Round ${lastRound.number} Result ---`, lastRound.result.summary);
      if (lastRound.result.highlights?.length) {
        lines.push('', 'Highlights:', ...lastRound.result.highlights.map(h => `  - ${h}`));
      }
    }
    lines.push('', 'Next steps:');
    lines.push(`  - delegate_continue(delegation_id="${delegation.id}", ...) to start another round`);
    lines.push(`  - delegate_close(delegation_id="${delegation.id}") to end the session`);
  } else if (isRunning(delegation)) {
    lines.push('', 'Task is still running...');
  } else if (delegation.state === 'completed') {
    if (delegation.result) {
      lines.push('', '--- Result ---', delegation.result.summary);
      if (delegation.result.highlights?.length) {
        lines.push('', 'Highlights:', ...delegation.result.highlights.map(h => `  - ${h}`));
      }
    }
    const pendingSnapshots = delegation.snapshots?.filter(s => s.status === 'pending') ?? [];
    if (pendingSnapshots.length > 0) {
      lines.push('', `${pendingSnapshots.length} pending snapshot(s) awaiting review`);
      lines.push('Use delegate_snapshots to list, delegate_apply_snapshot or delegate_discard_snapshot to act');
    }
  } else if (delegation.state === 'error' && delegation.error) {
    lines.push('', '--- Error ---');
    lines.push(`Code: ${delegation.error.code}`);
    lines.push(`Message: ${delegation.error.message}`);
    if (delegation.error.hint) {
      lines.push(`Hint: ${delegation.error.hint}`);
    }
  } else if (delegation.state === 'cancelled') {
    lines.push('', 'Delegation was cancelled.');
  }

  if (delegation.rounds?.length > 1) {
    lines.push('', '--- Round History ---');
    for (const round of delegation.rounds) {
      const status = round.completedAt ? 'done' : 'in progress';
      const result = round.result?.summary ?? `(${status})`;
      lines.push(`  Round ${round.number}: ${result}`);
    }
  }

  return lines.join('\n');
}

