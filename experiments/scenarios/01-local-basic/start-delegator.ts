/**
 * Start Delegator Daemon for the 01-local-basic scenario
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
  console.log('║         Starting AWCP Delegator Daemon                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Port:        ${PORT}`);
  console.log(`  Exports Dir: ${exportsDir}`);
  console.log('');

  const daemon = await startDelegatorDaemon({
    port: PORT,
    delegator: {
      baseDir: exportsDir,
      transport: new SshfsTransport({
        delegator: {
          host: 'localhost',
          user: process.env.USER || 'user',
          port: 22,
          caKeyPath: join(homedir(), '.awcp', 'ca'),
        },
      }),
    },
  });

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         Delegator Daemon Ready                             ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  API:         ${daemon.url.padEnd(44)}║`);
  console.log(`║  Delegate:    POST ${daemon.url}/delegate`.padEnd(61) + '║');
  console.log(`║  Status:      GET  ${daemon.url}/delegations`.padEnd(61) + '║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Press Ctrl+C to stop.');

  process.on('SIGINT', async () => {
    console.log('\nShutting down Delegator Daemon...');
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
