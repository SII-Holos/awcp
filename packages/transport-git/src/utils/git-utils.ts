import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitCredential } from '@awcp/core';

export async function execGit(cwd: string | null, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd: cwd ?? undefined,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`git ${args[0]} failed: ${stderr || stdout}`));
      }
    });

    proc.on('error', reject);
  });
}

export async function configureAuth(workDir: string, auth?: GitCredential): Promise<void> {
  if (!auth || auth.type === 'none') return;

  if (auth.type === 'token') {
    await execGit(workDir, ['config', 'credential.helper', 'store']);
  } else if (auth.type === 'ssh' && auth.privateKey) {
    const keyPath = path.join(workDir, '.git', 'awcp-key');
    await fs.promises.writeFile(keyPath, auth.privateKey, { mode: 0o600 });
    await execGit(workDir, ['config', 'core.sshCommand', `ssh -i ${keyPath} -o StrictHostKeyChecking=no`]);
  }
}

export async function cleanupAuth(workDir: string): Promise<void> {
  const keyPath = path.join(workDir, '.git', 'awcp-key');
  await fs.promises.unlink(keyPath).catch(() => {});
}
