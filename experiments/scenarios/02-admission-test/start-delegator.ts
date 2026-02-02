/**
 * Start Delegator Daemon for 02-admission-test scenario
 * 
 * This delegator has STRICT admission limits to test rejection:
 * - maxTotalBytes: 1KB
 * - maxFileCount: 3
 * - maxSingleFileBytes: 512B
 */

import { startDelegatorDaemon } from '@awcp/sdk';
import { SshfsTransport } from '@awcp/transport-sshfs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const SCENARIO_DIR = process.env.SCENARIO_DIR || process.cwd();
const PORT = parseInt(process.env.DELEGATOR_PORT || '3100', 10);

async function main() {
  const exportsDir = resolve(SCENARIO_DIR, 'exports');

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   Starting AWCP Delegator (Strict Admission Limits)        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Port:              ${PORT}`);
  console.log(`  Exports Dir:       ${exportsDir}`);
  console.log(`  Max Total Bytes:   1KB`);
  console.log(`  Max File Count:    3`);
  console.log(`  Max Single File:   512B`);
  console.log('');

  const daemon = await startDelegatorDaemon({
    port: PORT,
    delegator: {
      environment: {
        baseDir: exportsDir,
      },
      transport: new SshfsTransport({
        delegator: {
          host: 'localhost',
          user: process.env.USER || 'user',
          port: 22,
          caKeyPath: join(homedir(), '.awcp', 'ca'),
        },
      }),
      admission: {
        maxTotalBytes: 1024,        // 1KB - very strict!
        maxFileCount: 3,            // max 3 files
        maxSingleFileBytes: 512,    // 512 bytes per file
      },
    },
  });

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         Delegator Daemon Ready                             ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  process.on('SIGINT', async () => {
    await daemon.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await daemon.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start Delegator Daemon:', err);
  process.exit(1);
});
