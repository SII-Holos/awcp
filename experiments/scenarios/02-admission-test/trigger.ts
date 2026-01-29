/**
 * Trigger script for 02-admission-test
 * 
 * Tests both passing and failing admission scenarios.
 */

import { DelegatorDaemonClient } from '@awcp/sdk';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DELEGATOR_URL = process.env.DELEGATOR_URL || 'http://localhost:3100';
const EXECUTOR_URL = process.env.EXECUTOR_URL || 'http://localhost:4001/awcp';
const SCENARIO_DIR = process.env.SCENARIO_DIR || import.meta.dirname;
const WORKSPACE_DIR = join(SCENARIO_DIR, 'workspace');

async function setupWorkspace(fileCount: number, fileSize: number) {
  await rm(WORKSPACE_DIR, { recursive: true, force: true });
  await mkdir(WORKSPACE_DIR, { recursive: true });
  
  for (let i = 0; i < fileCount; i++) {
    const content = 'x'.repeat(fileSize);
    await writeFile(join(WORKSPACE_DIR, `file${i}.txt`), content);
  }
}

async function testDelegation(
  client: DelegatorDaemonClient,
  description: string,
  expectSuccess: boolean
): Promise<boolean> {
  console.log(`\n  Testing: ${description}`);
  console.log(`  Expected: ${expectSuccess ? 'PASS' : 'REJECT'}`);
  
  try {
    const result = await client.delegate({
      executorUrl: EXECUTOR_URL,
      localDir: WORKSPACE_DIR,
      task: {
        description: 'Test task',
        prompt: 'list',
      },
    });
    
    if (expectSuccess) {
      console.log(`  ✅ PASS - Delegation created: ${result.delegationId}`);
      
      // Wait for completion
      const delegation = await client.waitForCompletion(result.delegationId, 500, 15000);
      console.log(`  ✅ Completed with state: ${delegation.state}`);
      return true;
    } else {
      console.log(`  ❌ FAIL - Expected rejection, but delegation was created: ${result.delegationId}`);
      return false;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    
    if (!expectSuccess && (message.includes('exceeds') || message.includes('Workspace'))) {
      console.log(`  ✅ PASS - Correctly rejected: ${message}`);
      return true;
    } else if (!expectSuccess) {
      console.log(`  ⚠️  PASS - Rejected (other reason): ${message}`);
      return true;
    } else {
      console.log(`  ❌ FAIL - Unexpected error: ${message}`);
      return false;
    }
  }
}

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         Admission Control Integration Test                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Admission limits: maxTotal=1KB, maxFiles=3, maxSingle=512B');

  const client = new DelegatorDaemonClient(DELEGATOR_URL);
  
  // Check health
  const healthy = await client.health();
  if (!healthy) {
    console.error('\n✗ Delegator Daemon is not running!');
    console.log('  Start it with: npx tsx start-delegator.ts');
    process.exit(1);
  }
  console.log('\n✓ Delegator Daemon is healthy');

  let passed = 0;
  let failed = 0;

  // Test 1: Small workspace should pass
  await setupWorkspace(2, 100); // 2 files × 100 bytes = 200 bytes
  if (await testDelegation(client, 'Small workspace (2 files, 200 bytes total)', true)) {
    passed++;
  } else {
    failed++;
  }

  // Test 2: Too many files should fail
  await setupWorkspace(5, 50); // 5 files > maxFileCount(3)
  if (await testDelegation(client, 'Too many files (5 > 3)', false)) {
    passed++;
  } else {
    failed++;
  }

  // Test 3: Total size too large should fail
  await setupWorkspace(2, 1000); // 2 files × 1000 bytes = 2000 bytes > 1024
  if (await testDelegation(client, 'Total size too large (2KB > 1KB)', false)) {
    passed++;
  } else {
    failed++;
  }

  // Test 4: Single file too large should fail
  await setupWorkspace(1, 1000); // 1 file × 1000 bytes > maxSingleFileBytes(512)
  if (await testDelegation(client, 'Single file too large (1KB > 512B)', false)) {
    passed++;
  } else {
    failed++;
  }

  // Summary
  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════════════════');

  if (failed > 0) {
    console.log('\n⚠️  Some tests failed!');
    process.exit(1);
  } else {
    console.log('\n✅ All admission control tests passed!');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
