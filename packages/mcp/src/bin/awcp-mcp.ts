#!/usr/bin/env node
/**
 * AWCP MCP Server CLI
 *
 * Starts an MCP server that provides AWCP delegation tools.
 * Automatically starts the Delegator Daemon if not already running.
 */

// TODO: Replace with Logger injection in @awcp/sdk for structured, configurable logging
// MCP uses stdio for JSON-RPC — any console.log (stdout) corrupts the protocol stream.
// Redirect all console output to stderr before importing anything that might log.
console.log = console.error;
console.info = console.error;
console.warn = console.error;

import { createAwcpMcpServer } from '../server.js';
import { ensureDaemonRunning, type AutoDaemonOptions } from '../auto-daemon.js';
import { discoverPeers, type PeersContext } from '../peer-discovery.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createWriteStream, type WriteStream } from 'node:fs';
import type { AccessMode, SnapshotPolicy } from '@awcp/core';

interface ParsedArgs {
  // Daemon
  daemonUrl?: string;
  port: number;

  // Environment
  environmentDir?: string;

  // Transport
  transport: 'archive' | 'sshfs' | 'storage' | 'git';

  // Admission
  maxTotalBytes?: number;
  maxFileCount?: number;
  maxSingleFileBytes?: number;

  // Snapshot
  snapshotMode?: SnapshotPolicy;

  // Defaults
  defaultTtl?: number;
  defaultAccessMode?: AccessMode;

  // Archive transport
  tempDir?: string;

  // SSHFS transport
  sshCaKey?: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshKeyDir?: string;

  // Storage transport
  storageEndpoint?: string;
  storageLocalDir?: string;

  // Git transport
  gitRemoteUrl?: string;
  gitAuthType?: 'token' | 'ssh' | 'none';
  gitToken?: string;
  gitSshKeyPath?: string;
  gitBranchPrefix?: string;
  gitCleanupRemoteBranch?: boolean;

  // Peers
  peerUrls: string[];

  // Logging
  logFile?: string;
}

function parseArgs(args: string[]): ParsedArgs | null {
  const result: ParsedArgs = {
    port: 3100,
    transport: 'archive',
    peerUrls: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1] ?? '';

    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);

      // Daemon
      case '--daemon-url':
        result.daemonUrl = nextArg;
        i++;
        break;
      case '--port':
        result.port = parseInt(nextArg, 10);
        i++;
        break;

      // Environment
      case '--environment-dir':
        result.environmentDir = nextArg;
        i++;
        break;

      // Transport
      case '--transport':
        result.transport = nextArg as 'archive' | 'sshfs' | 'storage' | 'git';
        i++;
        break;

      // Admission
      case '--max-total-bytes':
        result.maxTotalBytes = parseInt(nextArg, 10);
        i++;
        break;
      case '--max-file-count':
        result.maxFileCount = parseInt(nextArg, 10);
        i++;
        break;
      case '--max-single-file-bytes':
        result.maxSingleFileBytes = parseInt(nextArg, 10);
        i++;
        break;

      // Snapshot
      case '--snapshot-mode':
        result.snapshotMode = nextArg as SnapshotPolicy;
        i++;
        break;

      // Defaults
      case '--default-ttl':
        result.defaultTtl = parseInt(nextArg, 10);
        i++;
        break;
      case '--default-access-mode':
        result.defaultAccessMode = nextArg as AccessMode;
        i++;
        break;

      // Archive transport
      case '--temp-dir':
        result.tempDir = nextArg;
        i++;
        break;

      // SSHFS transport
      case '--ssh-ca-key':
        result.sshCaKey = nextArg;
        i++;
        break;
      case '--ssh-host':
        result.sshHost = nextArg;
        i++;
        break;
      case '--ssh-port':
        result.sshPort = parseInt(nextArg, 10);
        i++;
        break;
      case '--ssh-user':
        result.sshUser = nextArg;
        i++;
        break;
      case '--ssh-key-dir':
        result.sshKeyDir = nextArg;
        i++;
        break;

      // Storage transport
      case '--storage-endpoint':
        result.storageEndpoint = nextArg;
        i++;
        break;
      case '--storage-local-dir':
        result.storageLocalDir = nextArg;
        i++;
        break;

      // Git transport
      case '--git-remote-url':
        result.gitRemoteUrl = nextArg;
        i++;
        break;
      case '--git-auth-type':
        result.gitAuthType = nextArg as 'token' | 'ssh' | 'none';
        i++;
        break;
      case '--git-token':
        result.gitToken = nextArg;
        i++;
        break;
      case '--git-ssh-key-path':
        result.gitSshKeyPath = nextArg;
        i++;
        break;
      case '--git-branch-prefix':
        result.gitBranchPrefix = nextArg;
        i++;
        break;
      case '--git-cleanup-remote-branch':
        result.gitCleanupRemoteBranch = nextArg !== 'false';
        i++;
        break;

      // Peers
      case '--peers':
        result.peerUrls = nextArg.split(',').map(u => u.trim()).filter(Boolean);
        i++;
        break;

      // Logging
      case '--log-file':
        result.logFile = nextArg;
        i++;
        break;
    }
  }

  return result;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    process.exit(1);
  }

  let logStream: WriteStream | undefined;
  if (parsed.logFile) {
    logStream = createWriteStream(parsed.logFile, { flags: 'a' });
    const originalConsoleError = console.error;
    const originalConsoleLog = console.log;
    const timestamp = () => new Date().toISOString();
    console.error = (...args) => {
      logStream!.write(`[${timestamp()}] ${args.join(' ')}\n`);
      originalConsoleError.apply(console, args);
    };
    console.log = (...args) => {
      logStream!.write(`[${timestamp()}] ${args.join(' ')}\n`);
      originalConsoleLog.apply(console, args);
    };
    console.error(`[AWCP MCP] Logging to ${parsed.logFile}`);
  }

  let peersContext: PeersContext | undefined;
  if (parsed.peerUrls.length > 0) {
    console.error(`[AWCP MCP] Discovering ${parsed.peerUrls.length} peer(s)...`);
    peersContext = await discoverPeers(parsed.peerUrls);
  }

  let finalDaemonUrl: string;

  if (parsed.daemonUrl) {
    finalDaemonUrl = parsed.daemonUrl;
    console.error(`[AWCP MCP] Using existing daemon at ${parsed.daemonUrl}`);
  } else {
    const options: AutoDaemonOptions = {
      port: parsed.port,
      environmentDir: parsed.environmentDir,
      transport: parsed.transport,
      maxTotalBytes: parsed.maxTotalBytes,
      maxFileCount: parsed.maxFileCount,
      maxSingleFileBytes: parsed.maxSingleFileBytes,
      snapshotMode: parsed.snapshotMode,
      defaultTtl: parsed.defaultTtl,
      defaultAccessMode: parsed.defaultAccessMode,
      tempDir: parsed.tempDir,
      sshCaKey: parsed.sshCaKey,
      sshHost: parsed.sshHost,
      sshPort: parsed.sshPort,
      sshUser: parsed.sshUser,
      sshKeyDir: parsed.sshKeyDir,
      storageEndpoint: parsed.storageEndpoint,
      storageLocalDir: parsed.storageLocalDir,
      gitRemoteUrl: parsed.gitRemoteUrl,
      gitAuthType: parsed.gitAuthType,
      gitToken: parsed.gitToken,
      gitSshKeyPath: parsed.gitSshKeyPath,
      gitBranchPrefix: parsed.gitBranchPrefix,
      gitCleanupRemoteBranch: parsed.gitCleanupRemoteBranch,
    };

    const result = await ensureDaemonRunning(options);
    finalDaemonUrl = result.url;

    if (result.daemon) {
      const cleanup = async () => {
        console.error('[AWCP MCP] Shutting down daemon...');
        await result.daemon!.stop();
        process.exit(0);
      };
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
    }
  }

  const server = createAwcpMcpServer({
    daemonUrl: finalDaemonUrl,
    defaultSnapshotMode: parsed.snapshotMode,
    peers: peersContext,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[AWCP MCP] Server started, daemon at ${finalDaemonUrl}`);
  if (peersContext && peersContext.peers.length > 0) {
    const available = peersContext.peers.filter(p => p.card).length;
    console.error(`[AWCP MCP] ${available}/${peersContext.peers.length} peers available`);
  }
}

function printHelp() {
  console.error(`AWCP MCP Server - Workspace Delegation Tools

Provides MCP tools for AI agents to delegate work to remote Executors:
  - delegate: Delegate a workspace to a remote Executor
  - delegate_output: Get delegation status/results
  - delegate_cancel: Cancel active delegations
  - delegate_snapshots: List snapshots for a delegation
  - delegate_apply_snapshot: Apply a staged snapshot
  - delegate_discard_snapshot: Discard a staged snapshot
  - delegate_recover: Recover results after connection loss

The daemon is automatically started if not running.

Usage:
  awcp-mcp [options]

Daemon Options:
  --daemon-url URL           Use existing Delegator Daemon (skips auto-start)
  --port PORT                Port for daemon (default: 3100)

Environment Options:
  --environment-dir DIR      Directory for environments (default: ~/.awcp/environments)

Transport Options:
  --transport TYPE           Transport: archive, sshfs, storage, git (default: archive)

Admission Control:
  --max-total-bytes N        Max workspace size in bytes (default: 100MB)
  --max-file-count N         Max number of files (default: 10000)
  --max-single-file-bytes N  Max single file size (default: 50MB)

Snapshot Options:
  --snapshot-mode MODE       Snapshot handling: auto, staged, discard (default: auto)

Delegation Defaults:
  --default-ttl SECONDS      Default lease duration (default: 3600)
  --default-access-mode MODE Default access: ro, rw (default: rw)

Archive Transport Options:
  --temp-dir DIR             Temp directory for archives (default: ~/.awcp/temp)

SSHFS Transport Options:
  --ssh-ca-key PATH          CA private key path (required for SSHFS)
  --ssh-host HOST            SSH server host (default: localhost)
  --ssh-port PORT            SSH server port (default: 22)
  --ssh-user USER            SSH username (default: current user)
  --ssh-key-dir DIR          SSH key directory (default: ~/.awcp/keys)

Storage Transport Options:
  --storage-endpoint URL     Storage endpoint URL (required for storage)
  --storage-local-dir DIR    Local directory for storage files

Git Transport Options:
  --git-remote-url URL       Git remote URL (required for git transport)
  --git-auth-type TYPE       Authentication: token, ssh, none (default: none)
  --git-token TOKEN          Git token (for --git-auth-type token)
  --git-ssh-key-path PATH    SSH key path (for --git-auth-type ssh)
  --git-branch-prefix PREFIX Branch prefix for task branches (default: awcp/)
  --git-cleanup-remote-branch BOOL  Delete remote branch after cleanup (default: true)

Peer Discovery:
  --peers URL,...            Comma-separated list of executor base URLs

Logging:
  --log-file PATH            Write daemon logs to file (for debugging)

Other:
  --help, -h                 Show this help message

Examples:
  # Basic usage with one peer
  awcp-mcp --peers http://localhost:4001

  # Staged snapshot mode (requires manual approval)
  awcp-mcp --peers http://localhost:4001 --snapshot-mode staged

  # Multiple peers
  awcp-mcp --peers http://agent1:4001,http://agent2:4002

  # Custom admission limits
  awcp-mcp --peers http://localhost:4001 --max-total-bytes 200000000

  # Use SSHFS transport
  awcp-mcp --peers http://localhost:4001 --transport sshfs --ssh-ca-key ~/.awcp/ca

  # Use Git transport with token auth
  awcp-mcp --peers http://localhost:4001 \\
    --transport git \\
    --git-remote-url https://github.com/user/repo.git \\
    --git-auth-type token \\
    --git-token ghp_xxxxx

Claude Desktop config (claude_desktop_config.json):
  {
    "mcpServers": {
      "awcp": {
        "command": "npx",
        "args": ["@awcp/mcp", "--peers", "http://localhost:4001"]
      }
    }
  }

The --peers flag fetches A2A Agent Cards at startup to provide context
about available executors and their capabilities to the LLM.
`);
}

main().catch((error) => {
  console.error('[AWCP MCP] Fatal error:', error);
  process.exit(1);
});
