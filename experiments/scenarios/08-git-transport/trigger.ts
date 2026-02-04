/**
 * Trigger script - Tests Git Transport with OpenClaw Executor
 *
 * This tests the AWCP Git Transport which uses Git clone/push
 * for workspace file transfer.
 *
 * Flow:
 * 1. Delegator initializes git repo and pushes to remote
 * 2. Executor clones repo and creates task branch
 * 3. Executor works on files
 * 4. Executor commits and pushes task branch
 * 5. Delegator fetches and merges changes
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXECUTOR_URL = process.env.EXECUTOR_URL || 'http://localhost:10202/awcp';
const EXECUTOR_BASE_URL = process.env.EXECUTOR_BASE_URL || 'http://localhost:10202';
const SCENARIO_DIR = process.env.SCENARIO_DIR || process.cwd();
const MCP_SERVER_PATH = resolve(__dirname, '../../../packages/mcp/dist/bin/awcp-mcp.js');

// Git transport configuration
const GIT_REMOTE_URL = process.env.AWCP_GIT_REMOTE_URL || resolve(SCENARIO_DIR, 'git-server/repo.git');

// Colors for output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const NC = '\x1b[0m';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

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

function generateTaskContext() {
  const now = new Date();
  const timestamp = now.toISOString();
  const randomId = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayOfWeek = days[now.getDay()] ?? 'Unknown';

  return { timestamp, randomId, dayOfWeek };
}

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Git Transport + OpenClaw Integration Test              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`MCP Server:      ${MCP_SERVER_PATH}`);
  console.log(`Scenario Dir:    ${SCENARIO_DIR}`);
  console.log(`Executor URL:    ${EXECUTOR_URL}`);
  console.log(`Git Remote:      ${GIT_REMOTE_URL}`);
  console.log('');

  // Create MCP client transport
  log(BLUE, '[MCP]', 'Starting MCP server via stdio transport...');

  const tempDir = resolve(SCENARIO_DIR, 'temp');
  const logFile = resolve(SCENARIO_DIR, 'logs/daemon.log');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [
      MCP_SERVER_PATH,
      '--peers', EXECUTOR_BASE_URL,
      '--temp-dir', tempDir,
      '--log-file', logFile,
      '--transport', 'git',
      '--git-remote-url', GIT_REMOTE_URL,
    ],
  });

  const client = new Client(
    { name: 'git-transport-test', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    log(GREEN, '✓', 'MCP client connected');

    // Test 1: Verify tools are available
    await testListTools(client);

    // Test 2: Git transport file modification
    await testGitTransport(client);

  } finally {
    await client.close();
    log(BLUE, '[MCP]', 'MCP client closed');
  }

  // Print summary
  printSummary();
}

async function testListTools(client: Client) {
  const testName = 'List MCP tools & verify configuration';
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

    // Verify delegate tool description
    const delegateTool = tools.find((t) => t.name === 'delegate');
    const description = delegateTool?.description || '';

    const hasPeerUrl = description.includes(EXECUTOR_BASE_URL);
    console.log(`  Peer URL in description: ${hasPeerUrl ? GREEN + '✓' : RED + '✗'}${NC}`);

    log(GREEN, '✓', 'All expected tools found');
    results.push({ name: testName, passed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(RED, '✗', message);
    results.push({ name: testName, passed: false, error: message });
  }
}

async function testGitTransport(client: Client) {
  const testName = 'Git transport file modification via OpenClaw';
  log(BLUE, '\n[TEST]', testName);

  const workspacePath = resolve(SCENARIO_DIR, 'workspace');
  const helloFilePath = resolve(workspacePath, 'hello.txt');

  // Generate dynamic context for this run
  const { timestamp, randomId, dayOfWeek } = generateTaskContext();

  console.log(`  Task context:`);
  console.log(`    - Timestamp: ${timestamp}`);
  console.log(`    - Random ID: ${randomId}`);
  console.log(`    - Day: ${dayOfWeek}`);
  console.log(`    - Transport: git (clone + push)`);
  console.log('');

  // Read original content
  const originalContent = readFileSync(helloFilePath, 'utf-8');
  console.log(`  Original hello.txt: "${originalContent.trim()}"`);

  try {
    log(YELLOW, '  →', 'Calling delegate tool with Git transport task...');

    // Create a task
    const taskDescription = `Update hello.txt via Git Transport (ID: ${randomId})`;
    const taskPrompt = `
Please modify the file hello.txt with the following requirements:

1. Keep the original first line "Hello from Git Transport test!"
2. Add a blank line after it
3. Add these new lines:
   - "--- Git Transport Log ---"
   - "Timestamp: ${timestamp}"
   - "Task ID: ${randomId}"
   - "Day: ${dayOfWeek}"
   - "Transport: Git (clone + commit + push)"
   - A creative greeting mentioning it's ${dayOfWeek} and celebrating successful Git-based file transfer
   - "--- End of Log ---"

Make the greeting unique and reference the Git transport technology.
`.trim();

    console.log('');
    console.log(`  ${CYAN}Task Description:${NC} ${taskDescription}`);
    console.log(`  ${CYAN}Transport:${NC} git (using local bare repository)`);
    console.log('');

    const result = (await client.callTool({
      name: 'delegate',
      arguments: {
        description: taskDescription,
        prompt: taskPrompt,
        workspace_dir: workspacePath,
        peer_url: EXECUTOR_URL,
        background: false,
      },
    })) as ToolResult;

    const text = getTextContent(result);
    console.log('  Result preview:', text?.slice(0, 300) + (text && text.length > 300 ? '...' : ''));

    // Check if result indicates error
    if (result.isError) {
      throw new Error('Delegation failed (MCP error): ' + text);
    }

    if (text?.includes('Status: error')) {
      const errorMatch = text.match(/--- Error ---\n(.+?)(?:\n|$)/);
      const errorMsg = errorMatch ? errorMatch[1] : 'Unknown error';
      throw new Error('Delegation failed: ' + errorMsg);
    }

    // Verify file was modified
    const newContent = readFileSync(helloFilePath, 'utf-8');
    console.log('');
    console.log(`  ${CYAN}New hello.txt content:${NC}`);
    console.log('  ┌─────────────────────────────────────────');
    for (const line of newContent.split('\n')) {
      console.log(`  │ ${line}`);
    }
    console.log('  └─────────────────────────────────────────');
    console.log('');

    // Verify the dynamic content was added
    const hasTimestamp = newContent.includes(timestamp) || newContent.includes('Timestamp');
    const hasTaskId = newContent.includes(randomId) || newContent.includes('Task ID');
    const hasDay = newContent.includes(dayOfWeek);
    const hasTransportRef = newContent.toLowerCase().includes('git') || newContent.toLowerCase().includes('commit');
    const wasModified = newContent !== originalContent;

    console.log('  Content verification:');
    console.log(`    - File modified: ${wasModified ? GREEN + '✓' : RED + '✗'}${NC}`);
    console.log(`    - Has timestamp: ${hasTimestamp ? GREEN + '✓' : YELLOW + '~'}${NC}`);
    console.log(`    - Has task ID: ${hasTaskId ? GREEN + '✓' : YELLOW + '~'}${NC}`);
    console.log(`    - Has day of week: ${hasDay ? GREEN + '✓' : YELLOW + '~'}${NC}`);
    console.log(`    - References transport: ${hasTransportRef ? GREEN + '✓' : YELLOW + '~'}${NC}`);
    console.log('');

    if (!wasModified) {
      log(YELLOW, '!', 'File was not modified');
      results.push({ name: testName, passed: false, error: 'File not modified' });
      return;
    }

    log(GREEN, '✓', 'File was successfully modified via Git transport');
    log(GREEN, '✓', 'Delegation completed successfully');
    results.push({ name: testName, passed: true });
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
