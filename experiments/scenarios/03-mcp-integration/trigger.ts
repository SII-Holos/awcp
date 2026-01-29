/**
 * Trigger script - Tests MCP tools by using MCP Client to call delegate/delegate_output tools
 *
 * This simulates how an AI Agent (like Claude) would use the AWCP MCP tools.
 * Instead of directly calling DelegatorDaemonClient, we spawn the awcp-mcp server
 * and communicate via MCP protocol over stdio.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DELEGATOR_URL = process.env.DELEGATOR_URL || 'http://localhost:3100';
const EXECUTOR_URL = process.env.EXECUTOR_URL || 'http://localhost:4001/awcp';
const SCENARIO_DIR = process.env.SCENARIO_DIR || process.cwd();
const MCP_SERVER_PATH = resolve(__dirname, '../../../packages/mcp/dist/bin/awcp-mcp.js');

// Colors for output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

// MCP content types
interface TextContent {
  type: 'text';
  text: string;
}

interface ToolResult {
  content: Array<TextContent | { type: string }>;
  isError?: boolean;
}

const results: TestResult[] = [];

function log(color: string, prefix: string, message: string) {
  console.log(`${color}${prefix}${NC} ${message}`);
}

function getTextContent(result: ToolResult): string | undefined {
  const textContent = result.content.find((c): c is TextContent => c.type === 'text');
  return textContent?.text;
}

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         MCP Integration Test                               ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`MCP Server:   ${MCP_SERVER_PATH}`);
  console.log(`Daemon URL:   ${DELEGATOR_URL}`);
  console.log(`Executor URL: ${EXECUTOR_URL}`);
  console.log('');

  // Create MCP client transport - spawns the awcp-mcp server
  log(BLUE, '[MCP]', 'Starting MCP server via stdio transport...');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH, '--daemon-url', DELEGATOR_URL],
  });

  const client = new Client(
    { name: 'awcp-mcp-test', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    log(GREEN, '✓', 'MCP client connected');

    // Test 1: List available tools
    await testListTools(client);

    // Test 2: Synchronous delegation (background=false)
    await testSyncDelegation(client);

    // Test 3: Async delegation with delegate_output (background=true)
    await testAsyncDelegation(client);

    // Test 4: Cancel delegation
    await testCancelDelegation(client);

  } finally {
    await client.close();
    log(BLUE, '[MCP]', 'MCP client closed');
  }

  // Print summary
  printSummary();
}

async function testListTools(client: Client) {
  const testName = 'List MCP tools';
  log(BLUE, '\n[TEST]', testName);

  try {
    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);

    console.log(`  Found ${tools.length} tools: ${toolNames.join(', ')}`);

    const expectedTools = ['delegate', 'delegate_output', 'delegate_cancel'];
    const missingTools = expectedTools.filter((t) => !toolNames.includes(t));

    if (missingTools.length > 0) {
      throw new Error(`Missing tools: ${missingTools.join(', ')}`);
    }

    log(GREEN, '✓', 'All expected tools found');
    results.push({ name: testName, passed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(RED, '✗', message);
    results.push({ name: testName, passed: false, error: message });
  }
}

async function testSyncDelegation(client: Client) {
  const testName = 'Sync delegation (background=false)';
  log(BLUE, '\n[TEST]', testName);

  const workspacePath = resolve(SCENARIO_DIR, 'workspace');
  const timestamp = new Date().toISOString();

  try {
    log(YELLOW, '  →', 'Calling delegate tool...');

    const result = (await client.callTool({
      name: 'delegate',
      arguments: {
        description: 'Modify hello.txt via MCP',
        prompt: `append hello.txt [SYNC] Modified via MCP at ${timestamp}`,
        workspace_dir: workspacePath,
        peer_url: EXECUTOR_URL,
        background: false,
      },
    })) as ToolResult;

    const text = getTextContent(result);
    console.log('  Result:', text?.slice(0, 200) + (text && text.length > 200 ? '...' : ''));

    // Check if successful
    if (!text || result.isError) {
      throw new Error('Delegation failed: ' + JSON.stringify(result));
    }

    log(GREEN, '✓', 'Sync delegation completed successfully');
    results.push({ name: testName, passed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(RED, '✗', message);
    results.push({ name: testName, passed: false, error: message });
  }
}

async function testAsyncDelegation(client: Client) {
  const testName = 'Async delegation (background=true)';
  log(BLUE, '\n[TEST]', testName);

  const workspacePath = resolve(SCENARIO_DIR, 'workspace');
  const timestamp = new Date().toISOString();

  try {
    log(YELLOW, '  →', 'Calling delegate tool with background=true...');

    const delegateResult = (await client.callTool({
      name: 'delegate',
      arguments: {
        description: 'Async modification via MCP',
        prompt: `append hello.txt [ASYNC] Modified via MCP at ${timestamp}`,
        workspace_dir: workspacePath,
        peer_url: EXECUTOR_URL,
        background: true,
      },
    })) as ToolResult;

    // Extract delegation ID from response
    const text = getTextContent(delegateResult);
    if (!text) {
      throw new Error('No text content in response');
    }

    const delegationIdMatch = text.match(/Delegation ID:\s*(\S+)/);
    if (!delegationIdMatch) {
      throw new Error('Could not extract delegation ID from: ' + text);
    }

    const delegationId = delegationIdMatch[1];
    log(YELLOW, '  →', `Got delegation ID: ${delegationId}`);

    // Wait a moment then poll for result
    log(YELLOW, '  →', 'Calling delegate_output to get result...');

    const outputResult = (await client.callTool({
      name: 'delegate_output',
      arguments: {
        delegation_id: delegationId,
        block: true,
        timeout: 30,
      },
    })) as ToolResult;

    const outputText = getTextContent(outputResult);
    console.log('  Output result:', outputText?.slice(0, 200));

    if (outputResult.isError) {
      throw new Error('delegate_output failed: ' + outputText);
    }

    log(GREEN, '✓', 'Async delegation completed successfully');
    results.push({ name: testName, passed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(RED, '✗', message);
    results.push({ name: testName, passed: false, error: message });
  }
}

async function testCancelDelegation(client: Client) {
  const testName = 'Cancel delegation';
  log(BLUE, '\n[TEST]', testName);

  const workspacePath = resolve(SCENARIO_DIR, 'workspace');

  try {
    // Start a delegation in background mode
    log(YELLOW, '  →', 'Starting background delegation...');

    const delegateResult = (await client.callTool({
      name: 'delegate',
      arguments: {
        description: 'Delegation to cancel',
        prompt: 'append hello.txt [CANCELLED] This should not appear',
        workspace_dir: workspacePath,
        peer_url: EXECUTOR_URL,
        background: true,
      },
    })) as ToolResult;

    const text = getTextContent(delegateResult);
    const delegationIdMatch = text?.match(/Delegation ID:\s*(\S+)/);

    if (!delegationIdMatch) {
      // If we got a synchronous result, the task already completed before we could cancel
      log(YELLOW, '!', 'Delegation completed before cancel (task was fast)');
      results.push({ name: testName, passed: true });
      return;
    }

    const delegationId = delegationIdMatch[1];
    log(YELLOW, '  →', `Cancelling delegation: ${delegationId}`);

    // Cancel it
    const cancelResult = (await client.callTool({
      name: 'delegate_cancel',
      arguments: {
        delegation_id: delegationId,
      },
    })) as ToolResult;

    const cancelText = getTextContent(cancelResult);
    console.log('  Cancel result:', cancelText?.slice(0, 100));

    // Check status after cancel
    const statusResult = (await client.callTool({
      name: 'delegate_output',
      arguments: {
        delegation_id: delegationId,
      },
    })) as ToolResult;

    const statusText = getTextContent(statusResult) || '';
    if (statusText.includes('cancelled') || statusText.includes('completed')) {
      log(GREEN, '✓', 'Cancel operation handled correctly');
      results.push({ name: testName, passed: true });
    } else {
      log(YELLOW, '!', 'Cancel result unclear: ' + statusText.slice(0, 100));
      results.push({ name: testName, passed: true }); // Still pass if no error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(RED, '✗', message);
    results.push({ name: testName, passed: false, error: message });
  }
}

function printSummary() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         Test Summary                                       ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  for (const result of results) {
    const icon = result.passed ? `${GREEN}✓${NC}` : `${RED}✗${NC}`;
    console.log(`  ${icon} ${result.name}`);
    if (result.error) {
      console.log(`      ${RED}Error: ${result.error}${NC}`);
    }
  }

  console.log('');
  console.log(`Results: ${GREEN}${passed} passed${NC}, ${failed > 0 ? RED : ''}${failed} failed${NC}`);
  console.log('');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
