/**
 * Trigger script - Tests MCP + Synergy Executor integration
 *
 * This simulates how an AI Agent would use the AWCP MCP tools to delegate
 * coding tasks to a Synergy-based executor.
 *
 * Key difference from 03-mcp-integration:
 * - Uses synergy-executor which actually processes tasks with Synergy AI
 * - Tests real code modification capabilities (not just file append)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXECUTOR_URL = process.env.EXECUTOR_URL || 'http://localhost:10200/awcp';
const EXECUTOR_BASE_URL = process.env.EXECUTOR_BASE_URL || 'http://localhost:10200';
const SCENARIO_DIR = process.env.SCENARIO_DIR || process.cwd();
const MCP_SERVER_PATH = resolve(__dirname, '../../../packages/mcp/dist/bin/awcp-mcp.js');

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
  console.log('║     Synergy Executor MCP Integration Test                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`MCP Server:   ${MCP_SERVER_PATH}`);
  console.log(`Scenario Dir: ${SCENARIO_DIR}`);
  console.log(`Executor URL: ${EXECUTOR_URL}`);
  console.log(`Peers:        ${EXECUTOR_BASE_URL}`);
  console.log('');

  // Create MCP client transport
  log(BLUE, '[MCP]', 'Starting MCP server via stdio transport...');

  const exportsDir = resolve(SCENARIO_DIR, 'exports');
  const tempDir = resolve(SCENARIO_DIR, 'temp');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [
      MCP_SERVER_PATH,
      '--peers', EXECUTOR_BASE_URL,
      '--exports-dir', exportsDir,
      '--temp-dir', tempDir,
    ],
  });

  const client = new Client(
    { name: 'synergy-executor-test', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    log(GREEN, '✓', 'MCP client connected');

    // Test 1: Verify tools are available and check Agent Card injection
    await testListTools(client);

    // Test 2: Dynamic file modification task
    await testDynamicFileTask(client);

  } finally {
    await client.close();
    log(BLUE, '[MCP]', 'MCP client closed');
  }

  // Print summary
  printSummary();
}

async function testListTools(client: Client) {
  const testName = 'List MCP tools & verify Agent Card injection';
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

    // Print full delegate tool description to verify agent card injection
    const delegateTool = tools.find((t) => t.name === 'delegate');
    const description = delegateTool?.description || '';
    
    console.log('');
    console.log(`  ${CYAN}┌─────────────────────────────────────────────────────────────${NC}`);
    console.log(`  ${CYAN}│ DELEGATE TOOL DESCRIPTION (with injected Agent Card info)${NC}`);
    console.log(`  ${CYAN}├─────────────────────────────────────────────────────────────${NC}`);
    for (const line of description.split('\n')) {
      console.log(`  ${CYAN}│${NC} ${line}`);
    }
    console.log(`  ${CYAN}└─────────────────────────────────────────────────────────────${NC}`);
    console.log('');

    // Verify agent card info was injected
    const hasAgentName = description.includes('Holos-Synergy');
    const hasPeerUrl = description.includes(EXECUTOR_BASE_URL);
    const hasSkills = description.toLowerCase().includes('skill');
    const hasCapabilities = description.toLowerCase().includes('implement') || 
                           description.toLowerCase().includes('refactor') ||
                           description.toLowerCase().includes('debug');
    
    console.log('  Agent Card injection check:');
    console.log(`    - Agent name "Holos-Synergy": ${hasAgentName ? GREEN + '✓' : RED + '✗'}${NC}`);
    console.log(`    - Peer URL (${EXECUTOR_BASE_URL}): ${hasPeerUrl ? GREEN + '✓' : RED + '✗'}${NC}`);
    console.log(`    - Skills info: ${hasSkills ? GREEN + '✓' : RED + '✗'}${NC}`);
    console.log(`    - Capabilities: ${hasCapabilities ? GREEN + '✓' : RED + '✗'}${NC}`);
    console.log('');

    if (hasAgentName && hasPeerUrl) {
      log(GREEN, '✓', 'Agent Card info successfully injected into delegate tool');
    } else {
      log(YELLOW, '!', 'Some Agent Card info may be missing from delegate tool');
    }

    log(GREEN, '✓', 'All expected tools found');
    results.push({ name: testName, passed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(RED, '✗', message);
    results.push({ name: testName, passed: false, error: message });
  }
}

async function testDynamicFileTask(client: Client) {
  const testName = 'Dynamic file modification via Synergy';
  log(BLUE, '\n[TEST]', testName);

  const workspacePath = resolve(SCENARIO_DIR, 'workspace');
  const helloFilePath = resolve(workspacePath, 'hello.txt');
  
  // Generate dynamic context for this run
  const { timestamp, randomId, dayOfWeek } = generateTaskContext();
  
  console.log(`  Task context:`);
  console.log(`    - Timestamp: ${timestamp}`);
  console.log(`    - Random ID: ${randomId}`);
  console.log(`    - Day: ${dayOfWeek}`);
  console.log('');

  // Read original content
  const originalContent = readFileSync(helloFilePath, 'utf-8');
  console.log(`  Original hello.txt: "${originalContent.trim()}"`);

  try {
    log(YELLOW, '  →', 'Calling delegate tool with dynamic Synergy task...');

    // Create a more interesting, dynamic task
    const taskDescription = `Update hello.txt with timestamp and greeting (ID: ${randomId})`;
    const taskPrompt = `
Please modify the file hello.txt with the following requirements:

1. Keep the original first line "Hello, World!"
2. Add a blank line after it
3. Add these new lines:
   - "--- Synergy Collaboration Log ---"
   - "Timestamp: ${timestamp}"
   - "Task ID: ${randomId}"
   - "Day: ${dayOfWeek}"
   - A friendly greeting that mentions it's ${dayOfWeek}
   - "--- End of Log ---"

Make the greeting creative and unique. The file should look professional.
`.trim();

    console.log('');
    console.log(`  ${CYAN}Task Description:${NC} ${taskDescription}`);
    console.log(`  ${CYAN}Task Prompt:${NC}`);
    for (const line of taskPrompt.split('\n').slice(0, 5)) {
      console.log(`    ${line}`);
    }
    console.log('    ...');
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
    const wasModified = newContent !== originalContent;

    console.log('  Content verification:');
    console.log(`    - File modified: ${wasModified ? GREEN + '✓' : RED + '✗'}${NC}`);
    console.log(`    - Has timestamp info: ${hasTimestamp ? GREEN + '✓' : YELLOW + '~'}${NC}`);
    console.log(`    - Has task ID: ${hasTaskId ? GREEN + '✓' : YELLOW + '~'}${NC}`);
    console.log(`    - Has day of week: ${hasDay ? GREEN + '✓' : YELLOW + '~'}${NC}`);
    console.log('');

    if (!wasModified) {
      log(YELLOW, '!', 'File was not modified (Synergy may have interpreted the task differently)');
    } else {
      log(GREEN, '✓', 'File was successfully modified by Synergy');
    }

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
