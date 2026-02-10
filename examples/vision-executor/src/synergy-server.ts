/**
 * Synergy Server Launcher
 *
 * Starts a headless Synergy server with proper configuration for
 * non-interactive automated execution (no agent switch prompts,
 * no plan confirmation questions).
 */

import { spawn } from 'node:child_process';

export interface SynergyServerOptions {
  hostname?: string;
  port?: number;
  timeout?: number;
}

const SYNERGY_CONFIG = {
  permission: {
    '*': 'allow',
    question: 'deny',
  },
  interaction: false,
};

export async function startSynergyServer(options?: SynergyServerOptions): Promise<{
  url: string;
  close: () => void;
}> {
  const hostname = options?.hostname ?? '127.0.0.1';
  const port = options?.port ?? 2026;
  const timeout = options?.timeout ?? 15000;

  const args = ['serve', `--hostname=${hostname}`, `--port=${port}`];

  const proc = spawn('synergy', args, {
    env: {
      ...process.env,
      SYNERGY_CONFIG_CONTENT: JSON.stringify(SYNERGY_CONFIG),
    },
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      proc.kill();
      reject(new Error(`Synergy server failed to start within ${timeout}ms`));
    }, timeout);

    let output = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('synergy server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(timeoutId);
            resolve(match[1]!);
            return;
          }
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on('exit', (code) => {
      clearTimeout(timeoutId);
      reject(new Error(`Synergy exited with code ${code}\n${output}`));
    });

    proc.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });

  console.log(`[SynergyServer] Started at ${url}`);

  return {
    url,
    close() {
      proc.kill();
      console.log('[SynergyServer] Stopped');
    },
  };
}
