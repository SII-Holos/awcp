/**
 * OpenClaw Gateway Manager
 *
 * Manages the OpenClaw Gateway process lifecycle.
 * The Gateway provides OpenAI-compatible HTTP API for AI inference.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './app-config.js';
import type { OpenClawConfig } from './openclaw-config.js';
import { generateGatewayConfig } from './openclaw-config.js';

export class OpenClawGatewayManager {
  private process: ChildProcess | null = null;
  private appConfig: AppConfig;
  private openclawConfig: OpenClawConfig;
  private configPath: string;
  private isStarted = false;

  constructor(appConfig: AppConfig, openclawConfig: OpenClawConfig) {
    this.appConfig = appConfig;
    this.openclawConfig = openclawConfig;
    this.configPath = path.join(openclawConfig.stateDir, 'openclaw.json');
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      console.log('[GatewayManager] Gateway already started');
      return;
    }

    await this.ensureDirectories();
    await this.writeConfig();

    console.log(`[GatewayManager] Starting OpenClaw Gateway on port ${this.openclawConfig.gatewayPort}...`);

    this.process = spawn('openclaw', [
      'gateway',
      '--port', String(this.openclawConfig.gatewayPort),
      '--token', this.openclawConfig.gatewayToken,
      '--allow-unconfigured',
    ], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: this.openclawConfig.stateDir,
        OPENCLAW_GATEWAY_TOKEN: this.openclawConfig.gatewayToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const logFile = path.join(this.appConfig.logsDir, 'openclaw-gateway.log');
    const logStream = await fs.open(logFile, 'a');

    this.process.stdout?.on('data', (data) => {
      logStream.write(data);
    });

    this.process.stderr?.on('data', (data) => {
      logStream.write(data);
    });

    this.process.on('error', (err) => {
      console.error('[GatewayManager] Gateway process error:', err);
    });

    this.process.on('exit', (code, signal) => {
      console.log(`[GatewayManager] Gateway exited with code ${code}, signal ${signal}`);
      this.isStarted = false;
    });

    await this.waitForHealth();
    this.isStarted = true;
    console.log(`[GatewayManager] Gateway started (PID: ${this.process.pid})`);
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    console.log('[GatewayManager] Stopping Gateway...');
    this.process.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill('SIGKILL');
        resolve();
      }, 5000);

      this.process?.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.process = null;
    this.isStarted = false;
    console.log('[GatewayManager] Gateway stopped');
  }

  async updateWorkspace(workspacePath: string): Promise<void> {
    console.log(`[GatewayManager] Updating workspace to: ${workspacePath}`);

    const gatewayConfig = generateGatewayConfig(this.openclawConfig, workspacePath);
    await fs.writeFile(this.configPath, JSON.stringify(gatewayConfig, null, 2));
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.openclawConfig.gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openclawConfig.gatewayToken}`,
        },
        body: JSON.stringify({
          model: 'test',
          messages: [],
        }),
        signal: AbortSignal.timeout(2000),
      });
      // 400 or 401 means server is up, just invalid request
      return response.status === 400 || response.status === 401 || response.status === 404 || response.ok;
    } catch {
      return false;
    }
  }

  private async waitForHealth(timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.checkHealth()) {
        return;
      }
      await sleep(500);
    }
    throw new Error('Gateway health check timeout');
  }

  private async ensureDirectories(): Promise<void> {
    await fs.mkdir(this.openclawConfig.stateDir, { recursive: true });
    await fs.mkdir(this.appConfig.logsDir, { recursive: true });
    await fs.mkdir(path.join(this.appConfig.dataDir, 'workdir'), { recursive: true });
    await fs.mkdir(path.join(this.appConfig.dataDir, 'temp'), { recursive: true });
  }

  private async writeConfig(): Promise<void> {
    const defaultWorkspace = path.join(this.appConfig.dataDir, 'workdir');
    const gatewayConfig = generateGatewayConfig(this.openclawConfig, defaultWorkspace);
    await fs.writeFile(this.configPath, JSON.stringify(gatewayConfig, null, 2));
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  get gatewayUrl(): string {
    return this.openclawConfig.gatewayUrl;
  }

  get gatewayToken(): string {
    return this.openclawConfig.gatewayToken;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
