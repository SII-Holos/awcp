/**
 * Start Delegator Daemon for 07-storage-transport scenario
 *
 * Uses StorageDelegatorTransport with LocalStorageProvider.
 * Files are stored locally and served via a separate HTTP storage server.
 */

import { startDelegatorDaemon } from '@awcp/sdk';
import { StorageDelegatorTransport } from '@awcp/transport-storage';
import { resolve } from 'node:path';

const SCENARIO_DIR = process.env.SCENARIO_DIR || process.cwd();
const PORT = parseInt(process.env.DELEGATOR_PORT || '3100', 10);
const STORAGE_LOCAL_DIR = process.env.AWCP_STORAGE_LOCAL_DIR || resolve(SCENARIO_DIR, 'storage');
const STORAGE_ENDPOINT = process.env.AWCP_STORAGE_ENDPOINT || 'http://localhost:3200';

async function main() {
  const exportsDir = resolve(SCENARIO_DIR, 'exports');
  const tempDir = resolve(SCENARIO_DIR, 'temp');

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Starting AWCP Delegator (Storage Transport)            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Port:           ${PORT}`);
  console.log(`  Exports Dir:    ${exportsDir}`);
  console.log(`  Temp Dir:       ${tempDir}`);
  console.log(`  Storage Dir:    ${STORAGE_LOCAL_DIR}`);
  console.log(`  Storage Server: ${STORAGE_ENDPOINT}`);
  console.log(`  Transport:      storage (pre-signed URLs)`);
  console.log('');

  const daemon = await startDelegatorDaemon({
    port: PORT,
    delegator: {
      baseDir: exportsDir,
      transport: new StorageDelegatorTransport({
        provider: {
          type: 'local',
          localDir: STORAGE_LOCAL_DIR,
          endpoint: STORAGE_ENDPOINT,
        },
        tempDir,
      }),
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
