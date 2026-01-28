/**
 * AWCP Experiment - CLI Tool
 * 
 * Command-line interface for controlling the experiment.
 * - delegate: Create a new delegation
 * - status: Check delegation status
 * - clean: Clean up mount points
 */

import { loadConfig, printConfig } from './config.js';
import { A2AClient } from './a2a/index.js';
import { HostDaemon } from '@awcp/sdk';
import { CredentialManager } from '@awcp/transport-sshfs';
import type { AwcpMessage, Delegation } from '@awcp/core';
import { rmdir, readdir } from 'fs/promises';
import { join } from 'path';

const config = loadConfig();

async function main() {
  const command = process.argv[2];
  
  switch (command) {
    case 'delegate':
      await runDelegate();
      break;
    case 'status':
      await runStatus();
      break;
    case 'clean':
      await runClean();
      break;
    default:
      printHelp();
  }
}

function printHelp() {
  console.log(`
AWCP Experiment CLI

Usage: npm run <command>

Commands:
  delegate    Create a new delegation to Remote
  status      Check status of a delegation
  clean       Clean up mount points

Options for delegate:
  --task="description"   Task description (default: "Process files in workspace")
  --prompt="prompt"      Full task prompt
  --ttl=3600             TTL in seconds (default: 3600)
  --access=rw            Access mode: ro or rw (default: rw)

Examples:
  npm run delegate
  npm run delegate -- --task="Add headers to files" --ttl=1800
  npm run status -- <delegation-id>
  npm run clean
`);
}

async function runDelegate() {
  console.log('[CLI] Creating delegation...\n');
  printConfig(config);

  // Parse arguments
  const args = process.argv.slice(3);
  let task = 'Process files in workspace';
  let prompt = 'Please process all files in this workspace according to the configured agent type.';
  let ttl = 3600;
  let accessMode: 'ro' | 'rw' = 'rw';

  for (const arg of args) {
    if (arg.startsWith('--task=')) {
      task = arg.slice(7);
    } else if (arg.startsWith('--prompt=')) {
      prompt = arg.slice(9);
    } else if (arg.startsWith('--ttl=')) {
      ttl = parseInt(arg.slice(6), 10);
    } else if (arg.startsWith('--access=')) {
      accessMode = arg.slice(9) as 'ro' | 'rw';
    }
  }

  // Initialize A2A client
  const a2aClient = new A2AClient({
    selfUrl: config.hostUrl,
  });

  // Initialize credential manager
  const credentialManager = new CredentialManager({
    sshHost: config.sshHost,
    sshPort: config.sshPort,
    sshUser: config.sshUser,
    keyDir: `${config.experimentRoot}/.keys`,
  });

  // Create a temporary HostDaemon for this CLI session
  const hostDaemon = new HostDaemon({
    admission: {
      maxTotalBytes: 100 * 1024 * 1024,
      maxFileCount: 10000,
    },
    export: {
      baseDir: `${config.experimentRoot}/.exports`,
      strategy: 'symlink',
    },
    defaultTtlSeconds: ttl,
    
    sendMessage: async (peerUrl: string, message: AwcpMessage) => {
      console.log(`[CLI] → Sending ${message.type} to ${peerUrl}`);
      await a2aClient.sendAwcpMessage(peerUrl, message);
    },
    
    generateCredential: async (delegationId: string, ttlSeconds: number) => {
      console.log(`[CLI] Generating credentials...`);
      return credentialManager.generateCredential(delegationId, ttlSeconds);
    },
    
    revokeCredential: async (delegationId: string) => {
      console.log(`[CLI] Revoking credentials...`);
      await credentialManager.revokeCredential(delegationId);
    },
  });

  // Set up event handlers
  hostDaemon.on('delegation:created', (d: Delegation) => {
    console.log(`[CLI] ✅ Delegation created: ${d.id}`);
  });

  hostDaemon.on('delegation:started', () => {
    console.log(`[CLI] 🚀 Remote started working...`);
  });

  hostDaemon.on('delegation:completed', (d: Delegation) => {
    console.log(`\n[CLI] 🎉 Delegation completed!`);
    console.log(`[CLI] Summary: ${d.result?.summary}`);
    if (d.result?.highlights?.length) {
      console.log(`[CLI] Modified files:`);
      d.result.highlights.forEach(f => console.log(`[CLI]   - ${f}`));
    }
  });

  hostDaemon.on('delegation:error', (_d: Delegation, error: Error) => {
    console.error(`[CLI] ❌ Error: ${error.message}`);
  });

  // We need to set up an HTTP server to receive responses
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  
  app.post('/a2a/message', async (req, res) => {
    try {
      const message = req.body;
      if (message.type === 'awcp' && message.payload) {
        await hostDaemon.handleMessage(message.payload);
      }
      res.json({ accepted: true, messageId: message.id });
    } catch (error) {
      res.status(500).json({ accepted: false, error: String(error) });
    }
  });

  const server = app.listen(config.hostPort, () => {
    console.log(`[CLI] Temporary server listening on port ${config.hostPort}`);
  });

  try {
    // Create the delegation
    console.log(`\n[CLI] Creating delegation...`);
    console.log(`[CLI]   Workspace: ${config.workspacePath}`);
    console.log(`[CLI]   Remote: ${config.remoteUrl}`);
    console.log(`[CLI]   Task: ${task}`);
    console.log(`[CLI]   TTL: ${ttl}s`);
    console.log(`[CLI]   Access: ${accessMode}\n`);

    const delegationId = await hostDaemon.createDelegation({
      peerUrl: config.remoteUrl,
      localDir: config.workspacePath,
      task: {
        description: task,
        prompt: prompt,
      },
      ttlSeconds: ttl,
      accessMode: accessMode,
    });

    console.log(`[CLI] Delegation ID: ${delegationId}`);
    console.log(`[CLI] Waiting for completion (timeout: 5 minutes)...\n`);

    // Wait for result
    const result = await hostDaemon.waitForResult(delegationId, 5 * 60 * 1000);
    
    console.log(`\n[CLI] Final state: ${result.state}`);
    
    if (result.state === 'completed') {
      console.log(`\n✅ Delegation completed successfully!`);
      console.log(`\nCheck your workspace for changes:`);
      console.log(`  ${config.workspacePath}`);
    }

  } catch (error) {
    console.error(`[CLI] Error:`, error);
  } finally {
    server.close();
    process.exit(0);
  }
}

async function runStatus() {
  const delegationId = process.argv[3];
  
  if (!delegationId) {
    console.log('Usage: npm run status -- <delegation-id>');
    console.log('\nNote: Status checking requires the Host server to be running.');
    return;
  }

  console.log(`[CLI] Checking status for delegation: ${delegationId}`);
  console.log('[CLI] Note: This requires the Host server to be running.');
  
  // For now, just print a message
  // In a full implementation, we'd query the Host server's API
  console.log('[CLI] Status checking via CLI is not yet implemented.');
  console.log('[CLI] Check the Host server logs for delegation status.');
}

async function runClean() {
  console.log('[CLI] Cleaning up mount points...');
  
  const mountPath = config.mountPath;
  
  try {
    const entries = await readdir(mountPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '.gitkeep') {
        const fullPath = join(mountPath, entry.name);
        console.log(`[CLI] Removing: ${fullPath}`);
        
        try {
          // Try to unmount first (in case it's still mounted)
          const { exec } = await import('child_process');
          await new Promise<void>((resolve) => {
            exec(`umount "${fullPath}" 2>/dev/null || fusermount -u "${fullPath}" 2>/dev/null || true`, () => {
              resolve();
            });
          });
          
          await rmdir(fullPath);
          console.log(`[CLI] ✓ Removed: ${fullPath}`);
        } catch (error) {
          console.error(`[CLI] ✗ Failed to remove ${fullPath}:`, error);
        }
      }
    }
    
    console.log('[CLI] Cleanup complete.');
  } catch (error) {
    console.error('[CLI] Error during cleanup:', error);
  }
}

main().catch((error) => {
  console.error('[CLI] Fatal error:', error);
  process.exit(1);
});
