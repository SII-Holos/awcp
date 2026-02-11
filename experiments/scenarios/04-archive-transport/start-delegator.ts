/**
 * Start Delegator Daemon for 04-archive-transport scenario
 *
 * Uses ArchiveDelegatorTransport instead of SshfsTransport.
 * No SSH/SSHFS dependencies required!
 */

import { startDelegatorDaemon } from '@awcp/sdk';
import { ArchiveDelegatorTransport } from '@awcp/transport-archive';
import { resolve } from 'node:path';

const SCENARIO_DIR = process.env.SCENARIO_DIR || process.cwd();
const PORT = parseInt(process.env.DELEGATOR_PORT || '3100', 10);

async function main() {
  const exportsDir = resolve(SCENARIO_DIR, 'exports');
  const tempDir = resolve(SCENARIO_DIR, 'temp');

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Starting AWCP Delegator (Archive Transport)            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Port:        ${PORT}`);
  console.log(`  Exports Dir: ${exportsDir}`);
  console.log(`  Temp Dir:    ${tempDir}`);
  console.log(`  Transport:   archive (HTTP-based, no SSHFS needed)`);
  console.log('');

  const daemon = await startDelegatorDaemon({
    port: PORT,
    delegator: {
      baseDir: exportsDir,
      transport: new ArchiveDelegatorTransport({ tempDir }),
    },
  });

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         Delegator Daemon Ready                             ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  API:         ${daemon.url.padEnd(44)}║`);
  console.log(`║  Delegate:    POST ${daemon.url}/delegate`.padEnd(61) + '║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Press Ctrl+C to stop.');

  process.on('SIGINT', async () => {
    console.log('\nShutting down Delegator Daemon...');
    await daemon.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await daemon.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start Delegator Daemon:', err);
  process.exit(1);
});
