/**
 * Auto-start Delegator Daemon
 *
 * Automatically starts the Delegator Daemon if not running.
 * Used by MCP server to provide zero-config experience.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DelegatorConfig, AccessMode } from '@awcp/sdk';
import { startDelegatorDaemon, type DaemonInstance } from '@awcp/sdk/delegator/daemon';
import { ArchiveTransport } from '@awcp/transport-archive';

/**
 * Options for auto-starting the daemon
 */
export interface AutoDaemonOptions {
  // === Daemon ===
  /** Port for the daemon (default: 3100) */
  port?: number;
  /** Timeout in ms to wait for daemon to start (default: 10000) */
  startTimeout?: number;

  // === Export ===
  /** Directory for workspace exports (default: ~/.awcp/exports) */
  exportsDir?: string;
  /** Export strategy: symlink, bind, worktree (default: symlink) */
  exportStrategy?: 'symlink' | 'bind' | 'worktree';

  // === Transport ===
  /** Transport type (default: archive) */
  transport?: 'archive' | 'sshfs';

  // === Admission Control ===
  /** Maximum total bytes for workspace (default: 100MB) */
  maxTotalBytes?: number;
  /** Maximum file count (default: 10000) */
  maxFileCount?: number;
  /** Maximum single file size in bytes (default: 50MB) */
  maxSingleFileBytes?: number;

  // === Defaults ===
  /** Default TTL in seconds (default: 3600) */
  defaultTtl?: number;
  /** Default access mode: ro or rw (default: rw) */
  defaultAccessMode?: AccessMode;

  // === Archive Transport Options ===
  /** Directory for temp files (default: ~/.awcp/temp) */
  tempDir?: string;

  // === SSHFS Transport Options ===
  /** Path to CA private key (required for SSHFS) */
  sshCaKey?: string;
  /** SSH server host (default: localhost) */
  sshHost?: string;
  /** SSH server port (default: 22) */
  sshPort?: number;
  /** SSH username (default: current user) */
  sshUser?: string;
  /** Directory for SSH keys (default: ~/.awcp/keys) */
  sshKeyDir?: string;
}

/**
 * Default AWCP directory
 */
function getAwcpDir(): string {
  return process.env.AWCP_HOME || join(homedir(), '.awcp');
}

/**
 * Check if daemon is running by hitting health endpoint
 */
async function isDaemonRunning(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for daemon to become healthy
 */
async function waitForDaemon(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isDaemonRunning(url)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Create default delegator config
 */
async function createDefaultConfig(options: AutoDaemonOptions): Promise<DelegatorConfig> {
  const awcpDir = getAwcpDir();
  const exportsDir = options.exportsDir || join(awcpDir, 'exports');
  const tempDir = options.tempDir || join(awcpDir, 'temp');

  // Create transport based on type
  let transport;
  if (options.transport === 'sshfs') {
    // Dynamically import SSHFS transport to avoid requiring it when not used
    const { SshfsTransport } = await import('@awcp/transport-sshfs');
    
    if (!options.sshCaKey) {
      throw new Error('SSHFS transport requires --ssh-ca-key option');
    }
    
    transport = new SshfsTransport({
      delegator: {
        caKeyPath: options.sshCaKey,
        keyDir: options.sshKeyDir || join(awcpDir, 'keys'),
        host: options.sshHost || 'localhost',
        port: options.sshPort || 22,
        user: options.sshUser || process.env.USER,
      },
    });
  } else {
    // Default to Archive transport (no SSHFS setup required)
    transport = new ArchiveTransport({
      delegator: {
        tempDir,
      },
    });
  }

  return {
    environment: {
      baseDir: exportsDir,
    },
    transport,
    admission: {
      maxTotalBytes: options.maxTotalBytes,
      maxFileCount: options.maxFileCount,
      maxSingleFileBytes: options.maxSingleFileBytes,
    },
    defaults: {
      ttlSeconds: options.defaultTtl,
      accessMode: options.defaultAccessMode,
    },
  };
}

/**
 * Ensure AWCP directories exist
 */
async function ensureDirectories(options: AutoDaemonOptions): Promise<void> {
  const awcpDir = getAwcpDir();
  const exportsDir = options.exportsDir || join(awcpDir, 'exports');
  const tempDir = options.tempDir || join(awcpDir, 'temp');

  await mkdir(awcpDir, { recursive: true });
  await mkdir(exportsDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
}

/**
 * Start daemon in-process
 *
 * This starts the daemon in the same process as the MCP server.
 * Simpler but means the daemon dies when MCP server dies.
 */
export async function startInProcessDaemon(
  options: AutoDaemonOptions = {}
): Promise<DaemonInstance> {
  const port = options.port ?? 3100;

  await ensureDirectories(options);

  const config = await createDefaultConfig(options);

  const daemon = await startDelegatorDaemon({
    port,
    delegator: config,
  });

  return daemon;
}

/**
 * Ensure daemon is running, starting it if necessary
 *
 * Returns the daemon URL. If daemon is already running, just returns the URL.
 * If not running, starts it in-process and returns the URL.
 */
export async function ensureDaemonRunning(
  options: AutoDaemonOptions = {}
): Promise<{ url: string; daemon?: DaemonInstance }> {
  const port = options.port ?? 3100;
  const url = `http://localhost:${port}`;
  const startTimeout = options.startTimeout ?? 10000;

  // Check if already running
  if (await isDaemonRunning(url)) {
    console.error(`[AWCP] Daemon already running at ${url}`);
    return { url };
  }

  // Start daemon in-process
  console.error(`[AWCP] Starting Delegator Daemon on port ${port}...`);

  try {
    const daemon = await startInProcessDaemon(options);

    // Wait for it to be ready
    if (await waitForDaemon(url, startTimeout)) {
      console.error(`[AWCP] Daemon started successfully at ${url}`);
      return { url, daemon };
    } else {
      throw new Error('Daemon started but health check failed');
    }
  } catch (error) {
    throw new Error(
      `Failed to start Delegator Daemon: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
