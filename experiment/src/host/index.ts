/**
 * AWCP Experiment - Host Server
 * 
 * The Host (Delegator) side of the AWCP protocol.
 * - Runs an A2A HTTP server
 * - Manages HostDaemon from @awcp/sdk
 * - Handles credential generation via @awcp/transport-sshfs
 */

import { HostDaemon } from '@awcp/sdk';
import { CredentialManager } from '@awcp/transport-sshfs';
import { createA2AServer, A2AClient } from '../a2a/index.js';
import { loadConfig, printConfig, ExperimentConfig } from '../config.js';
import type { AwcpMessage, Delegation } from '@awcp/core';

let hostDaemon: HostDaemon;
let a2aClient: A2AClient;
let config: ExperimentConfig;

/**
 * Initialize and start the Host server
 */
async function main() {
  // Load configuration
  const configFile = process.argv[2];
  config = loadConfig(configFile);
  
  console.log('[Host] Starting AWCP Host Server...');
  printConfig(config);

  // Initialize A2A client for sending messages
  a2aClient = new A2AClient({
    selfUrl: config.hostUrl,
  });

  // Initialize credential manager
  const credentialManager = new CredentialManager({
    sshHost: config.sshHost,
    sshPort: config.sshPort,
    sshUser: config.sshUser,
    keyDir: `${config.experimentRoot}/.keys`,
  });

  // Initialize Host Daemon
  hostDaemon = new HostDaemon({
    admission: {
      maxTotalBytes: 100 * 1024 * 1024, // 100MB
      maxFileCount: 10000,
    },
    export: {
      baseDir: `${config.experimentRoot}/.exports`,
      strategy: 'symlink',
    },
    defaultTtlSeconds: 3600,
    
    // A2A message sending
    sendMessage: async (peerUrl: string, message: AwcpMessage) => {
      console.log(`[Host] → Sending ${message.type} to ${peerUrl}`);
      await a2aClient.sendAwcpMessage(peerUrl, message);
    },
    
    // Credential management
    generateCredential: async (delegationId: string, ttlSeconds: number) => {
      console.log(`[Host] Generating credentials for delegation ${delegationId.slice(0, 8)}...`);
      return credentialManager.generateCredential(delegationId, ttlSeconds);
    },
    
    revokeCredential: async (delegationId: string) => {
      console.log(`[Host] Revoking credentials for delegation ${delegationId.slice(0, 8)}...`);
      await credentialManager.revokeCredential(delegationId);
    },
  });

  // Set up event handlers
  setupEventHandlers();

  // Create and start A2A server
  const server = createA2AServer({
    port: config.hostPort,
    name: 'Host',
    onAwcpMessage: handleIncomingMessage,
  });

  await server.start();
  
  console.log('[Host] Server is ready. Waiting for CLI commands or Remote responses...');
  console.log(`[Host] To create a delegation, run: npm run delegate`);

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Host] Shutting down...');
    await server.stop();
    process.exit(0);
  });
}

/**
 * Handle incoming AWCP messages from Remote
 */
async function handleIncomingMessage(message: AwcpMessage, senderUrl: string): Promise<void> {
  console.log(`[Host] Processing ${message.type} from ${senderUrl}`);
  await hostDaemon.handleMessage(message);
}

/**
 * Set up Host Daemon event handlers
 */
function setupEventHandlers() {
  hostDaemon.on('delegation:created', (delegation: Delegation) => {
    console.log(`[Host] ✅ Delegation created: ${delegation.id.slice(0, 8)}...`);
    console.log(`[Host]    Task: ${delegation.task.description}`);
    console.log(`[Host]    Peer: ${delegation.peerUrl}`);
  });

  hostDaemon.on('delegation:started', (delegation: Delegation) => {
    console.log(`[Host] 🚀 Delegation started: ${delegation.id.slice(0, 8)}...`);
    console.log(`[Host]    Remote is now working on the task...`);
  });

  hostDaemon.on('delegation:completed', (delegation: Delegation) => {
    console.log(`[Host] 🎉 Delegation completed: ${delegation.id.slice(0, 8)}...`);
    console.log(`[Host]    Summary: ${delegation.result?.summary}`);
    if (delegation.result?.highlights?.length) {
      console.log(`[Host]    Highlights:`);
      delegation.result.highlights.forEach(h => console.log(`[Host]      - ${h}`));
    }
  });

  hostDaemon.on('delegation:error', (delegation: Delegation, error: Error) => {
    console.error(`[Host] ❌ Delegation error: ${delegation.id.slice(0, 8)}...`);
    console.error(`[Host]    Error: ${error.message}`);
  });

  hostDaemon.on('delegation:cancelled', (delegation: Delegation) => {
    console.log(`[Host] ⚠️ Delegation cancelled: ${delegation.id.slice(0, 8)}...`);
  });
}

/**
 * Export for CLI usage
 */
export async function createDelegation(params: {
  peerUrl: string;
  localDir: string;
  task: { description: string; prompt: string };
  ttlSeconds?: number;
  accessMode?: 'ro' | 'rw';
}): Promise<string> {
  return hostDaemon.createDelegation(params);
}

export function getStatus(delegationId: string): Delegation | undefined {
  return hostDaemon.getStatus(delegationId);
}

export async function waitForResult(delegationId: string, timeoutMs?: number): Promise<Delegation> {
  return hostDaemon.waitForResult(delegationId, timeoutMs);
}

export { hostDaemon, config };

// Run if executed directly
main().catch((error) => {
  console.error('[Host] Fatal error:', error);
  process.exit(1);
});
