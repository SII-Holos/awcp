/**
 * AWCP Executor Configuration
 */

import path from 'node:path';
import type { ExecutorConfig, TaskStartContext } from '@awcp/sdk';
import { resolveWorkDir, HttpListener, WebSocketTunnelListener } from '@awcp/sdk';
import type { InviteMessage, TransportAdapter, ListenerAdapter } from '@awcp/core';
import { ArchiveTransport } from '@awcp/transport-archive';
import { SshfsTransport } from '@awcp/transport-sshfs';
import { StorageTransport } from '@awcp/transport-storage';
import { GitTransport } from '@awcp/transport-git';
import type { AppConfig } from './app-config.js';
import type { OpenClawExecutor } from './openclaw-executor.js';
import type { OpenClawGatewayManager } from './gateway-manager.js';

function createTransport(tempDir: string): TransportAdapter {
  const type = process.env.AWCP_TRANSPORT || 'archive';
  if (type === 'sshfs') {
    console.log('[AWCP] Using SSHFS transport');
    return new SshfsTransport();
  }
  if (type === 'storage') {
    console.log('[AWCP] Using Storage transport');
    return new StorageTransport({ executor: { tempDir } });
  }
  if (type === 'git') {
    console.log('[AWCP] Using Git transport');
    const remoteUrl = process.env.AWCP_GIT_REMOTE_URL;
    if (!remoteUrl) {
      throw new Error('AWCP_GIT_REMOTE_URL is required for git transport');
    }
    return new GitTransport({
      delegator: { remoteUrl, auth: { type: 'none' }, tempDir },
      executor: { tempDir },
    });
  }
  console.log('[AWCP] Using Archive transport');
  return new ArchiveTransport({ executor: { tempDir } });
}

function createListeners(): ListenerAdapter[] {
  const listeners: ListenerAdapter[] = [new HttpListener()];

  if (process.env.AWCP_TUNNEL_SERVER) {
    console.log('[AWCP] Tunnel enabled');
    listeners.push(
      new WebSocketTunnelListener({
        server: process.env.AWCP_TUNNEL_SERVER,
        token: process.env.AWCP_TUNNEL_TOKEN!,
        reconnect: { enabled: true, maxRetries: 10, delayMs: 5000 },
      }),
    );
  }

  return listeners;
}

export function createAwcpConfig(
  appConfig: AppConfig,
  executor: OpenClawExecutor,
  gatewayManager: OpenClawGatewayManager,
): ExecutorConfig {
  const workDir = path.join(appConfig.dataDir, 'workdir');
  const tempDir = path.join(appConfig.dataDir, 'temp');

  return {
    workDir,
    transport: createTransport(tempDir),
    listeners: createListeners(),

    sandbox: {
      cwdOnly: true,
      allowNetwork: true,
      allowExec: true,
    },

    policy: {
      maxConcurrentDelegations: 3,
      maxTtlSeconds: 7200,
      autoAccept: false,
    },

    hooks: {
      onInvite: async (invite: InviteMessage) => {
        console.log(`[AWCP] INVITE: ${invite.delegationId} - ${invite.task.description}`);
        return true;
      },

      onTaskStart: async (ctx: TaskStartContext) => {
        const resolvedWorkDir = resolveWorkDir(ctx);
        console.log(`[AWCP] Task started: ${ctx.delegationId}`);
        console.log(`[AWCP] Working directory: ${resolvedWorkDir}`);

        executor.setWorkingDirectory(resolvedWorkDir, {
          delegationId: ctx.delegationId,
          taskId: ctx.delegationId,
          leaseExpiresAt: new Date(ctx.lease.expiresAt),
        });

        await gatewayManager.updateWorkspace(resolvedWorkDir);
      },

      onTaskComplete: (delegationId: string, _summary: string) => {
        console.log(`[AWCP] Completed: ${delegationId}`);
        executor.clearWorkingDirectory();
      },

      onError: (delegationId: string, error: Error) => {
        console.error(`[AWCP] Error: ${delegationId}`, error.message);
        executor.clearWorkingDirectory();
      },

      onListenerConnected: (info) => {
        console.log(`[AWCP] Listener ready: ${info.type} -> ${info.publicUrl}`);
      },

      onListenerDisconnected: (type, error) => {
        console.warn(`[AWCP] Listener disconnected: ${type}`, error?.message);
      },
    },
  };
}
