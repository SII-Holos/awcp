#!/usr/bin/env node
/**
 * AWCP MCP Server CLI
 *
 * Starts an MCP server that provides AWCP delegation tools.
 * Automatically starts the Delegator Daemon if not already running.
 *
 * Usage:
 *   awcp-mcp [options]
 *
 * See --help for all options.
 */

import { createAwcpMcpServer } from '../server.js';
import { ensureDaemonRunning, type AutoDaemonOptions } from '../auto-daemon.js';
import { discoverPeers, type PeersContext } from '../peer-discovery.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createWriteStream, type WriteStream } from 'node:fs';
import type { AccessMode } from '@awcp/core';

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
      // Help
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

  // Setup log file if specified
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

  // Discover peers (fetch Agent Cards)
  let peersContext: PeersContext | undefined;
  if (parsed.peerUrls.length > 0) {
    console.error(`[AWCP MCP] Discovering ${parsed.peerUrls.length} peer(s)...`);
    peersContext = await discoverPeers(parsed.peerUrls);
  }

  // Determine daemon URL
  let finalDaemonUrl: string;

  if (parsed.daemonUrl) {
    // Use provided daemon URL (no auto-start)
    finalDaemonUrl = parsed.daemonUrl;
    console.error(`[AWCP MCP] Using existing daemon at ${parsed.daemonUrl}`);
  } else {
    // Build auto-daemon options from parsed args
    const options: AutoDaemonOptions = {
      port: parsed.port,
      environmentDir: parsed.environmentDir,
      transport: parsed.transport,
      maxTotalBytes: parsed.maxTotalBytes,
      maxFileCount: parsed.maxFileCount,
      maxSingleFileBytes: parsed.maxSingleFileBytes,
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
    };

    const result = await ensureDaemonRunning(options);
    finalDaemonUrl = result.url;

    // Handle shutdown to clean up daemon
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

  // Create MCP server with peers context
  const server = createAwcpMcpServer({
    daemonUrl: finalDaemonUrl,
    peers: peersContext,
  });

  // Connect via stdio
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

Peer Discovery:
  --peers URL,...            Comma-separated list of executor base URLs

Logging:
  --log-file PATH            Write daemon logs to file (for debugging)

Other:
  --help, -h                 Show this help message

Examples:
  # Basic usage with one peer
  awcp-mcp --peers http://localhost:4001

  # Multiple peers
  awcp-mcp --peers http://agent1:4001,http://agent2:4002

  # Custom admission limits
  awcp-mcp --peers http://localhost:4001 --max-total-bytes 200000000

  # Use SSHFS transport
  awcp-mcp --peers http://localhost:4001 --transport sshfs --ssh-ca-key ~/.awcp/ca

  # Use Git transport (local bare repo)
  awcp-mcp --peers http://localhost:4001 --transport git --git-remote-url /path/to/repo.git

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
