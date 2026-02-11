/**
 * Trigger script for 07-storage-transport scenario
 *
 * Creates a delegation using Storage transport (pre-signed URLs).
 */

import { DelegatorDaemonClient } from '@awcp/sdk';
import { resolve } from 'node:path';

const DELEGATOR_URL = process.env.DELEGATOR_URL || 'http://localhost:3100';
const EXECUTOR_URL = process.env.EXECUTOR_URL || 'http://localhost:4001/awcp';
const SCENARIO_DIR = process.env.SCENARIO_DIR || process.cwd();

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Storage Transport Delegation Test                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  const client = new DelegatorDaemonClient(DELEGATOR_URL);

  const healthy = await client.health();
  if (!healthy) {
    console.error('❌ Delegator Daemon is not running at', DELEGATOR_URL);
    process.exit(1);
  }
  console.log('✓ Delegator Daemon is healthy');

  const workspacePath = resolve(SCENARIO_DIR, 'workspace');
  const timestamp = new Date().toISOString();

  console.log('');
  console.log('Creating delegation...');
  console.log(`  Executor URL: ${EXECUTOR_URL}`);
  console.log(`  Workspace:    ${workspacePath}`);
  console.log(`  Transport:    storage (pre-signed URLs)`);
  console.log('');

  try {
    const result = await client.delegate({
      executorUrl: EXECUTOR_URL,
      environment: {
        resources: [{ name: 'workspace', type: 'fs', source: workspacePath, mode: 'rw' }],
      },
      task: {
        description: 'Modify hello.txt via Storage transport',
        prompt: `append hello.txt [Storage Transport] Modified at ${timestamp}`,
      },
    });

    console.log(`✓ Delegation created: ${result.delegationId}`);
    console.log('');
    console.log('Waiting for completion...');
    console.log('  (Executor will: download from URL → extract → modify → upload to URL)');

    const delegation = await client.waitForCompletion(result.delegationId, 1000, 60000);

    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         Delegation Complete!                               ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`State:   ${delegation.state}`);
    const appliedSnapshot = delegation.snapshots?.find(s => s.status === 'applied');
    if (appliedSnapshot) {
      console.log(`Summary: ${appliedSnapshot.summary}`);
    }
    if (delegation.error) {
      console.log(`Error:   ${delegation.error.message}`);
    }
    console.log('');
    console.log('Check workspace/hello.txt to see the changes!');

  } catch (error) {
    console.error('❌ Delegation failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
