/**
 * Trigger script - Multimodal Capability Test
 *
 * Tests AWCP's ability to handle multimodal tasks:
 * - Image analysis and understanding
 * - Content-based file organization
 * - Report generation from visual inspection
 *
 * This demonstrates delegating complex visual AI tasks through AWCP.
 */

import { DelegatorDaemonClient } from '@awcp/sdk';
import { resolve } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

const DELEGATOR_URL = process.env.DELEGATOR_URL || 'http://localhost:3100';
const EXECUTOR_URL = process.env.EXECUTOR_URL || 'http://localhost:10200/awcp';
const SCENARIO_DIR = process.env.SCENARIO_DIR || process.cwd();

// Colors for output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const NC = '\x1b[0m';

function log(color: string, prefix: string, message: string) {
  console.log(`${color}${prefix}${NC} ${message}`);
}

async function getWorkspaceInfo(workspacePath: string): Promise<{
  totalFiles: number;
  imageFiles: string[];
  totalSizeBytes: number;
}> {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff'];
  const imageFiles: string[] = [];
  let totalFiles = 0;
  let totalSizeBytes = 0;

  async function scan(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(fullPath);
      } else {
        totalFiles++;
        const stats = await stat(fullPath);
        totalSizeBytes += stats.size;
        
        const ext = entry.name.toLowerCase().slice(entry.name.lastIndexOf('.'));
        if (imageExtensions.includes(ext)) {
          imageFiles.push(fullPath.replace(workspacePath + '/', ''));
        }
      }
    }
  }

  await scan(workspacePath);
  return { totalFiles, imageFiles, totalSizeBytes };
}

async function startDelegatorDaemon(): Promise<void> {
  const { startDelegatorDaemon } = await import('@awcp/sdk');
  const { ArchiveTransport } = await import('@awcp/transport-archive');

  const exportsDir = resolve(SCENARIO_DIR, 'exports');
  const tempDir = resolve(SCENARIO_DIR, 'temp');

  await startDelegatorDaemon({
    port: 3100,
    delegator: {
      baseDir: exportsDir,
      transport: new ArchiveTransport({
        delegator: { tempDir },
      }),
    },
  });
}

async function main() {
  console.log('');
  console.log(`${CYAN}╔════════════════════════════════════════════════════════════╗${NC}`);
  console.log(`${CYAN}║     AWCP Multimodal Capability Test                        ║${NC}`);
  console.log(`${CYAN}╚════════════════════════════════════════════════════════════╝${NC}`);
  console.log('');

  const workspacePath = resolve(SCENARIO_DIR, 'workspace');
  
  // Analyze workspace
  log(BLUE, '[INFO]', 'Analyzing workspace...');
  const info = await getWorkspaceInfo(workspacePath);
  
  console.log(`  Total files:  ${info.totalFiles}`);
  console.log(`  Image files:  ${info.imageFiles.length}`);
  console.log(`  Total size:   ${(info.totalSizeBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log('');

  if (info.imageFiles.length === 0) {
    log(YELLOW, '[WARN]', 'No image files found in workspace.');
    log(YELLOW, '[WARN]', 'Add images to workspace/images/ and run again.');
    process.exit(0);
  }

  // Start delegator daemon
  log(BLUE, '[INFO]', 'Starting Delegator Daemon...');
  await startDelegatorDaemon();
  log(GREEN, '✓', 'Delegator Daemon started');

  // Create client
  const client = new DelegatorDaemonClient(DELEGATOR_URL);

  // Wait for health
  for (let i = 0; i < 30; i++) {
    if (await client.health()) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (!await client.health()) {
    log(RED, '✗', 'Delegator Daemon not healthy');
    process.exit(1);
  }

  // Build task prompt
  const imageList = info.imageFiles.slice(0, 20).map(f => `  - ${f}`).join('\n');
  const taskPrompt = `
# Multimodal Analysis Task

You have access to a workspace containing ${info.imageFiles.length} image file(s).

## Your Tasks

### 1. Image Analysis
Analyze each image in the workspace and identify:
- What the image depicts (objects, scenes, people, text, etc.)
- Image quality assessment (resolution, clarity, composition)
- Any notable features or issues

### 2. File Organization
Based on your analysis:
- Create appropriate subdirectories by category (e.g., photos/, screenshots/, documents/, etc.)
- Rename files with descriptive names if they have generic names like IMG_001.jpg
- Move files to their appropriate categories

### 3. Generate Report
Create a file called \`analysis_report.md\` with:
- Summary of all images analyzed
- Categories created and file counts
- Any issues found (corrupted files, duplicates, low quality)
- Recommendations for the user

## Image Files Found
${imageList}
${info.imageFiles.length > 20 ? `  ... and ${info.imageFiles.length - 20} more` : ''}

## Important Notes
- Be thorough in your analysis
- Preserve original files if unsure about categorization
- Use clear, descriptive names in English
- The report should be well-formatted Markdown
`.trim();

  log(BLUE, '[INFO]', 'Creating multimodal delegation...');
  console.log('');
  console.log(`${CYAN}Task Summary:${NC}`);
  console.log(`  • Analyze ${info.imageFiles.length} images`);
  console.log(`  • Organize files by content category`);
  console.log(`  • Generate analysis report`);
  console.log('');

  try {
    const result = await client.delegate({
      executorUrl: EXECUTOR_URL,
      environment: {
        resources: [{ name: 'workspace', type: 'fs', source: workspacePath, mode: 'rw' }],
      },
      task: {
        description: `Multimodal analysis: analyze ${info.imageFiles.length} images, organize by category, generate report`,
        prompt: taskPrompt,
      },
    });

    log(GREEN, '✓', `Delegation created: ${result.delegationId}`);
    console.log('');
    log(YELLOW, '[INFO]', 'Waiting for completion (this may take a while for large workspaces)...');

    const delegation = await client.waitForCompletion(result.delegationId, 2000, 600000); // 10 min timeout

    console.log('');
    log(GREEN, '✓', 'Delegation completed!');
    console.log(`  State:   ${delegation.state}`);
    
    const appliedSnapshot = delegation.snapshots?.find(s => s.status === 'applied');
    if (appliedSnapshot) {
      console.log(`  Summary: ${appliedSnapshot.summary}`);
    }

    // Check for report
    try {
      const reportPath = resolve(workspacePath, 'analysis_report.md');
      const report = await readFile(reportPath, 'utf-8');
      console.log('');
      log(GREEN, '✓', 'Analysis report generated successfully');
      console.log('');
      console.log(`${CYAN}═══════════════════════════════════════════════════════════════${NC}`);
      console.log(`${CYAN}                    ANALYSIS REPORT PREVIEW                    ${NC}`);
      console.log(`${CYAN}═══════════════════════════════════════════════════════════════${NC}`);
      console.log(report.slice(0, 2000));
      if (report.length > 2000) {
        console.log(`\n... (${report.length - 2000} more characters, see full report in workspace)`);
      }
      console.log(`${CYAN}═══════════════════════════════════════════════════════════════${NC}`);
    } catch {
      log(YELLOW, '[WARN]', 'Report file not found (AI may have used different filename)');
    }

    process.exit(0);
  } catch (error) {
    log(RED, '✗', `Delegation failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
