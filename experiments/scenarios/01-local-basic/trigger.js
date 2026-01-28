/**
 * Trigger script - Creates a delegation via DelegatorDaemonClient
 */
import { DelegatorDaemonClient } from '@awcp/sdk';
import { resolve } from 'node:path';
const DELEGATOR_URL = process.env.DELEGATOR_URL || 'http://localhost:3100';
const EXECUTOR_URL = process.env.EXECUTOR_URL || 'http://localhost:4001/awcp';
const SCENARIO_DIR = process.env.SCENARIO_DIR || process.cwd();
async function main() {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         Triggering AWCP Delegation                         ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    const client = new DelegatorDaemonClient(DELEGATOR_URL);
    // Check health
    const healthy = await client.health();
    if (!healthy) {
        console.error('❌ Delegator Daemon is not running at', DELEGATOR_URL);
        process.exit(1);
    }
    console.log('✓ Delegator Daemon is healthy');
    // Create delegation
    const workspacePath = resolve(SCENARIO_DIR, 'workspace');
    const timestamp = new Date().toISOString();
    console.log('');
    console.log('Creating delegation...');
    console.log(`  Executor URL: ${EXECUTOR_URL}`);
    console.log(`  Workspace:    ${workspacePath}`);
    console.log('');
    try {
        const result = await client.delegate({
            executorUrl: EXECUTOR_URL,
            localDir: workspacePath,
            task: {
                description: 'Modify hello.txt',
                prompt: `append hello.txt Modified by AWCP at ${timestamp}`,
            },
        });
        console.log(`✓ Delegation created: ${result.delegationId}`);
        console.log('');
        console.log('Waiting for completion...');
        // Wait for completion
        const delegation = await client.waitForCompletion(result.delegationId, 1000, 30000);
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║         Delegation Complete!                               ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log('');
        console.log(`State:   ${delegation.state}`);
        if (delegation.result) {
            console.log(`Summary: ${delegation.result.summary}`);
        }
        console.log('');
        console.log('Check workspace/hello.txt to see the changes!');
    }
    catch (error) {
        console.error('❌ Delegation failed:', error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=trigger.js.map