/**
 * AWCP Experiment - Remote Server
 * 
 * The Remote (Collaborator) side of the AWCP protocol.
 * - Runs an A2A HTTP server
 * - Manages RemoteDaemon from @awcp/sdk
 * - Handles SSHFS mounting via @awcp/transport-sshfs
 * - Executes tasks using MockAgent
 */

import { RemoteDaemon } from '@awcp/sdk';
import { SshfsMountClient } from '@awcp/transport-sshfs';
import { createA2AServer, A2AClient } from '../a2a/index.js';
import { loadConfig, printConfig, ExperimentConfig } from '../config.js';
import { MockAgent, TaskParams, TaskResult } from './mock-agent.js';
import type { AwcpMessage, InviteMessage } from '@awcp/core';
import { mkdir } from 'fs/promises';

let remoteDaemon: RemoteDaemon;
let a2aClient: A2AClient;
let config: ExperimentConfig;
let mockAgent: MockAgent;
let sshfsClient: SshfsMountClient;

/**
 * Initialize and start the Remote server
 */
async function main() {
  // Load configuration
  const configFile = process.argv[2];
  config = loadConfig(configFile);
  
  console.log('[Remote] Starting AWCP Remote Server...');
  printConfig(config);

  // Ensure mount directory exists
  await mkdir(config.mountPath, { recursive: true });

  // Initialize A2A client for sending messages
  a2aClient = new A2AClient({
    selfUrl: config.remoteUrl,
  });

  // Initialize SSHFS client
  sshfsClient = new SshfsMountClient({
    tempKeyDir: `${config.experimentRoot}/.client-keys`,
    defaultOptions: {
      'reconnect': '',
      'ServerAliveInterval': '15',
      'ServerAliveCountMax': '3',
    },
  });

  // Check SSHFS availability
  const sshfsCheck = await sshfsClient.checkDependency();
  if (!sshfsCheck.available) {
    console.warn('[Remote] ⚠️ SSHFS is not available!');
    console.warn('[Remote] Install sshfs for full functionality:');
    console.warn('[Remote]   macOS: brew install macfuse && brew install sshfs');
    console.warn('[Remote]   Linux: apt install sshfs');
    console.warn('[Remote] Continuing in mock mode (no actual mounting)...\n');
  } else {
    console.log(`[Remote] ✓ SSHFS available (version: ${sshfsCheck.version || 'unknown'})`);
  }
  // Initialize Mock Agent
  mockAgent = new MockAgent({
    type: config.mockAgentType as 'add-header' | 'create-summary' | 'uppercase-comments',
  });
  console.log(`[Remote] ✓ Mock Agent initialized (type: ${config.mockAgentType})`);

  // Initialize Remote Daemon
  remoteDaemon = new RemoteDaemon({
    policy: {
      mountRoot: config.mountPath,
      maxConcurrent: 5,
      // Allow experiment paths (override default forbidden paths for testing)
      forbiddenPaths: [
        '/',
        '/etc',
        '/usr',
        '/bin',
        '/sbin',
        '/var',
        '/root',
        '/System',
        '/Library',
        '/Applications',
      ],
    },
    sandboxProfile: {
      cwdOnly: true,
      allowNetwork: true,
      allowExec: true,
    },
    
    // A2A message sending
    sendMessage: async (peerUrl: string, message: AwcpMessage) => {
      console.log(`[Remote] → Sending ${message.type} to ${peerUrl}`);
      await a2aClient.sendAwcpMessage(peerUrl, message);
    },
    
    // SSHFS mount
    mount: async (params) => {
      console.log(`[Remote] 🔗 Mounting workspace...`);
      console.log(`[Remote]    From: ${params.endpoint.user}@${params.endpoint.host}:${params.exportLocator}`);
      console.log(`[Remote]    To:   ${params.mountPoint}`);
      
      if (sshfsCheck.available) {
        await sshfsClient.mount(params);
        console.log(`[Remote] ✓ Mount successful`);
      } else {
        // Mock mode: create symlink to workspace for testing
        console.log(`[Remote] ⚠️ SSHFS not available, using symlink mock...`);
        const { symlink, rm } = await import('fs/promises');
        try {
          await rm(params.mountPoint, { recursive: true, force: true });
        } catch { /* ignore */ }
        await symlink(params.exportLocator, params.mountPoint);
        console.log(`[Remote] ✓ Mock mount (symlink) created`);
      }
    },
    
    // SSHFS unmount
    unmount: async (mountPoint: string) => {
      console.log(`[Remote] 🔓 Unmounting ${mountPoint}...`);
      if (sshfsCheck.available) {
        await sshfsClient.unmount(mountPoint);
      } else {
        // Mock mode: remove symlink
        const { rm } = await import('fs/promises');
        try {
          await rm(mountPoint, { force: true });
        } catch { /* ignore */ }
      }
      console.log(`[Remote] ✓ Unmount successful`);
    },
    
    // Task execution
    executeTask: async (params: TaskParams): Promise<TaskResult> => {
      console.log(`[Remote] 🤖 Executing task...`);
      console.log(`[Remote]    Description: ${params.task.description}`);
      console.log(`[Remote]    Workspace: ${params.mountPoint}`);
      
      const result = await mockAgent.execute(params);
      
      console.log(`[Remote] ✓ Task completed`);
      console.log(`[Remote]    Summary: ${result.summary}`);
      
      return result;
    },
  });

  // Set up event handlers
  setupEventHandlers();

  // Create and start A2A server
  const server = createA2AServer({
    port: config.remotePort,
    name: 'Remote',
    onAwcpMessage: handleIncomingMessage,
  });

  await server.start();
  
  console.log('[Remote] Server is ready. Waiting for invitations from Host...');

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Remote] Shutting down...');
    await sshfsClient.unmountAll();
    await server.stop();
    process.exit(0);
  });
}

/**
 * Handle incoming AWCP messages from Host
 */
async function handleIncomingMessage(message: AwcpMessage, senderUrl: string): Promise<void> {
  console.log(`[Remote] Processing ${message.type} from ${senderUrl}`);
  await remoteDaemon.handleMessage(message, senderUrl);
}

/**
 * Set up Remote Daemon event handlers
 */
function setupEventHandlers() {
  remoteDaemon.on('invitation:received', (invite: InviteMessage, peerUrl: string) => {
    console.log(`[Remote] 📥 Invitation received from ${peerUrl}`);
    console.log(`[Remote]    Task: ${invite.task.description}`);
    console.log(`[Remote]    TTL: ${invite.lease.ttlSeconds}s`);
    console.log(`[Remote]    Access: ${invite.lease.accessMode}`);
  });

  remoteDaemon.on('task:started', (delegationId: string, mountPoint: string) => {
    console.log(`[Remote] 🚀 Task started: ${delegationId.slice(0, 8)}...`);
    console.log(`[Remote]    Working directory: ${mountPoint}`);
  });

  remoteDaemon.on('task:completed', (delegationId: string, summary: string) => {
    console.log(`[Remote] 🎉 Task completed: ${delegationId.slice(0, 8)}...`);
    console.log(`[Remote]    Summary: ${summary}`);
  });

  remoteDaemon.on('task:failed', (delegationId: string, error: Error) => {
    console.error(`[Remote] ❌ Task failed: ${delegationId.slice(0, 8)}...`);
    console.error(`[Remote]    Error: ${error.message}`);
  });
}

export { remoteDaemon, config };

// Run if executed directly
main().catch((error) => {
  console.error('[Remote] Fatal error:', error);
  process.exit(1);
});
