/**
 * AWCP Executor Configuration
 *
 * This file demonstrates the standard AWCP configuration for an Executor.
 * Any AI assistant can be integrated with AWCP by following this pattern.
 *
 * Key components:
 * - workDir: Where delegated workspaces are extracted
 * - transport: How files are transferred (Archive or SSHFS)
 * - sandbox: Security constraints for task execution
 * - policy: Limits on concurrent delegations, TTL, etc.
 * - hooks: Lifecycle callbacks for custom integration
 */

import path from 'node:path';
import type { ExecutorConfig, TaskStartContext } from '@awcp/sdk';
import { resolveWorkDir } from '@awcp/sdk';
import type { InviteMessage, TransportAdapter } from '@awcp/core';
import { ArchiveTransport } from '@awcp/transport-archive';
import { SshfsTransport } from '@awcp/transport-sshfs';
import type { AppConfig } from './app-config.js';
import type { OpenClawExecutor } from './openclaw-executor.js';
import type { OpenClawGatewayManager } from './gateway-manager.js';

// --- Transport Configuration ---

const transportType = process.env.AWCP_TRANSPORT || 'archive';

function createTransport(tempDir: string): TransportAdapter {
  switch (transportType) {
    case 'sshfs':
      console.log('[AWCP] Using SSHFS transport');
      return new SshfsTransport();

    case 'archive':
    default:
      console.log('[AWCP] Using Archive transport (HTTP-based)');
      return new ArchiveTransport({
        executor: { tempDir },
      });
  }
}

// --- AWCP Executor Configuration ---

export function createAwcpConfig(
  appConfig: AppConfig,
  executor: OpenClawExecutor,
  gatewayManager: OpenClawGatewayManager,
): ExecutorConfig {
  const workDir = path.join(appConfig.dataDir, 'workdir');
  const tempDir = path.join(appConfig.dataDir, 'temp');

  return {
    // Where delegated workspaces are stored
    workDir,

    // Transport adapter for file transfer
    transport: createTransport(tempDir),

    // Sandbox profile - security constraints
    sandbox: {
      cwdOnly: true,      // Restrict file access to workspace
      allowNetwork: true, // Allow network access for AI tasks
      allowExec: true,    // Allow command execution
    },

    // Policy constraints
    policy: {
      maxConcurrentDelegations: 3,
      maxTtlSeconds: 7200, // 2 hours max
      autoAccept: false,   // Require explicit acceptance
    },

    // Lifecycle hooks - integrate your AI assistant here
    hooks: {
      /**
       * Called when an INVITE is received.
       * Return true to accept, false to decline.
       */
      onInvite: async (invite: InviteMessage) => {
        console.log(`[AWCP] Received INVITE: ${invite.delegationId}`);
        console.log(`[AWCP] Task: ${invite.task.description}`);
        console.log(`[AWCP] Accepting invitation`);
        return true;
      },

      /**
       * Called when task execution starts.
       * This is where you configure your AI assistant's workspace.
       */
      onTaskStart: async (ctx: TaskStartContext) => {
        const { delegationId, workPath, lease } = ctx;

        // Resolve the actual working directory from environment resources
        const resolvedWorkDir = resolveWorkDir(ctx);

        console.log(`[AWCP] Task started: ${delegationId}`);
        console.log(`[AWCP] Workspace root: ${workPath}`);
        console.log(`[AWCP] Working directory: ${resolvedWorkDir}`);
        console.log(`[AWCP] Lease expires: ${lease.expiresAt}`);

        // Configure your AI assistant to use this workspace
        executor.setWorkingDirectory(resolvedWorkDir, {
          delegationId,
          taskId: delegationId,
          leaseExpiresAt: new Date(lease.expiresAt),
        });

        // Update OpenClaw Gateway workspace
        await gatewayManager.updateWorkspace(resolvedWorkDir);
      },

      /**
       * Called when task completes successfully.
       */
      onTaskComplete: (delegationId: string, summary: string) => {
        console.log(`[AWCP] Task completed: ${delegationId}`);
        console.log(`[AWCP] Summary: ${summary.slice(0, 200)}...`);

        // Clean up AI assistant state
        executor.clearWorkingDirectory();
      },

      /**
       * Called when task fails with an error.
       */
      onError: (delegationId: string, error: Error) => {
        console.error(`[AWCP] Task error: ${delegationId}`, error.message);

        // Clean up AI assistant state
        executor.clearWorkingDirectory();
      },
    },
  };
}
