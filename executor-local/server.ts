#!/usr/bin/env bun
/**
 * Local AWCP Executor Server (LLM-powered)
 *
 * Accepts delegated workspaces via AWCP protocol, sends workspace context
 * to GPT-4.1-mini via SII API, and applies file modifications.
 *
 * Usage:
 *   bun run executor-local/server.ts
 *   bun run executor-local/server.ts --port 10200
 *
 * Environment:
 *   SII_API_KEY  - Required. API key for SII OpenAI-compatible endpoint.
 */

import express from 'express';
import { createServer } from 'node:http';
import { readdir, stat, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { executorHandler } from '@awcp/sdk/server/express';
import { ArchiveExecutorTransport } from '@awcp/transport-archive';
import type { TaskExecutor, TaskExecutionContext, TaskExecutionResult } from '@awcp/sdk';

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') ?? '10200', 10);
const WORK_DIR = process.argv.find((_, i, a) => a[i - 1] === '--work-dir') ?? '/tmp/awcp-executor-local';
const MODEL = process.argv.find((_, i, a) => a[i - 1] === '--model') ?? 'gpt-4.1-mini';

const SII_API_BASE = 'http://apicz.boyuerichdata.com/v1';
const SII_API_KEY = process.env.SII_API_KEY;

if (!SII_API_KEY) {
  console.error('[Executor] ERROR: SII_API_KEY environment variable is required.');
  console.error('  export SII_API_KEY="sk-..."');
  process.exit(1);
}

const AGENT_CARD = {
  name: 'Local LLM Executor',
  description: `AWCP executor powered by ${MODEL} via SII API. Can read, analyze, and modify workspace files based on natural language instructions.`,
  url: `http://localhost:${PORT}`,
  version: '0.2.0',
  capabilities: {
    protocols: ['awcp/1.0'],
  },
  skills: [
    {
      id: 'code-assistant',
      name: 'Code Assistant',
      description: 'Read, analyze, review, refactor, and modify code in the workspace. Can fix bugs, add features, write tests, and improve code quality.',
      examples: [
        'Fix the authentication bug in this project',
        'Add unit tests for the utils module',
        'Refactor the API handlers to use async/await',
      ],
    },
    {
      id: 'file-analysis',
      name: 'File Analysis',
      description: 'Analyze workspace files and provide insights, summaries, or documentation.',
      examples: [
        'Summarize the architecture of this project',
        'Review this code for security vulnerabilities',
        'Generate API documentation from the source code',
      ],
    },
    {
      id: 'content-generation',
      name: 'Content Generation',
      description: 'Generate new files, documentation, configs, or content based on requirements.',
      examples: [
        'Create a README for this project',
        'Generate a Dockerfile for this Node.js app',
        'Write a migration script based on the schema changes',
      ],
    },
  ],
};

interface FileInfo {
  path: string;
  size: number;
  isDir: boolean;
}

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.json5',
  '.md', '.mdx', '.txt', '.rst',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.hpp',
  '.sh', '.bash', '.zsh', '.fish',
  '.html', '.htm', '.css', '.scss', '.less', '.svg',
  '.sql', '.graphql', '.gql',
  '.env', '.env.example', '.gitignore', '.dockerignore',
  '.xml', '.csv',
  '.vue', '.svelte', '.astro',
  'Dockerfile', 'Makefile', 'Taskfile',
]);

function isTextFile(filePath: string): boolean {
  const name = filePath.split('/').pop() ?? '';
  if (TEXT_EXTENSIONS.has(name)) return true;
  const ext = '.' + name.split('.').pop()?.toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

async function walkDir(dir: string, base: string): Promise<FileInfo[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: FileInfo[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(base, fullPath);

    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;

    if (entry.isDirectory()) {
      results.push({ path: relPath + '/', size: 0, isDir: true });
      results.push(...await walkDir(fullPath, base));
    } else {
      const info = await stat(fullPath);
      results.push({ path: relPath, size: info.size, isDir: false });
    }
  }

  return results;
}

async function buildWorkspaceContext(workPath: string, files: FileInfo[]): Promise<string> {
  const maxFileSize = 32_768;
  const maxTotalChars = 120_000;
  let totalChars = 0;

  const fileListing = files
    .map(f => f.isDir ? `  ${f.path}` : `  ${f.path} (${formatSize(f.size)})`)
    .join('\n');

  const sections: string[] = [
    `## Workspace File Tree\n\n${fileListing}\n`,
  ];
  totalChars += sections[0].length;

  const textFiles = files.filter(f => !f.isDir && isTextFile(f.path) && f.size <= maxFileSize && f.size > 0);

  for (const file of textFiles) {
    if (totalChars >= maxTotalChars) {
      sections.push(`\n(Remaining ${textFiles.length - sections.length + 1} files omitted due to context limit)`);
      break;
    }

    try {
      const content = await readFile(join(workPath, file.path), 'utf-8');
      const budget = maxTotalChars - totalChars;
      const truncated = content.length > budget;
      const text = truncated ? content.slice(0, budget) : content;

      const block = `\n## File: ${file.path}\n\`\`\`\n${text}${truncated ? '\n... (truncated)' : ''}\n\`\`\`\n`;
      sections.push(block);
      totalChars += block.length;
    } catch {
      // skip unreadable
    }
  }

  return sections.join('\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FileOperation {
  action: 'write' | 'delete';
  path: string;
  content?: string;
}

function parseFileOperations(response: string): FileOperation[] {
  const ops: FileOperation[] = [];
  const writeRegex = /<<<WRITE_FILE path="([^"]+)">>>\n([\s\S]*?)<<<\/WRITE_FILE>>>/g;
  const deleteRegex = /<<<DELETE_FILE path="([^"]+)">>>/g;

  let match: RegExpExecArray | null;

  while ((match = writeRegex.exec(response)) !== null) {
    ops.push({ action: 'write', path: match[1], content: match[2] });
  }

  while ((match = deleteRegex.exec(response)) !== null) {
    ops.push({ action: 'delete', path: match[1] });
  }

  return ops;
}

async function applyFileOperations(workPath: string, ops: FileOperation[]): Promise<string[]> {
  const applied: string[] = [];

  for (const op of ops) {
    const fullPath = join(workPath, op.path);

    if (!fullPath.startsWith(workPath)) {
      console.warn(`[Executor] Skipping path escape attempt: ${op.path}`);
      continue;
    }

    try {
      if (op.action === 'write' && op.content !== undefined) {
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, op.content, 'utf-8');
        applied.push(`✏️ wrote ${op.path}`);
      } else if (op.action === 'delete') {
        await unlink(fullPath);
        applied.push(`🗑️ deleted ${op.path}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      applied.push(`⚠️ failed ${op.action} ${op.path}: ${msg}`);
    }
  }

  return applied;
}

async function callLLM(systemPrompt: string, userMessage: string): Promise<string> {
  const response = await fetch(`${SII_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SII_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 16384,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  if (data.usage) {
    console.log(`[Executor] Tokens: ${data.usage.prompt_tokens} in / ${data.usage.completion_tokens} out / ${data.usage.total_tokens} total`);
  }

  return data.choices[0]?.message?.content ?? '';
}

const SYSTEM_PROMPT = `You are a skilled software engineer acting as an AWCP Executor. You receive a workspace (file tree + file contents) and a task description. Your job is to analyze the workspace and complete the task.

## Response Format

Your response MUST contain two sections:

### 1. Summary
Start with a clear summary of what you did or found. Use markdown formatting.

### 2. File Operations (if needed)
If the task requires modifying files, use these markers:

To create or overwrite a file:
<<<WRITE_FILE path="relative/path/to/file">>>
file content here
<<</WRITE_FILE>>>

To delete a file:
<<<DELETE_FILE path="relative/path/to/file">>>

## Rules
- File paths must EXACTLY match the paths shown in the file tree (e.g. if you see "workspace/src/index.ts", use path="workspace/src/index.ts")
- Always provide complete file contents when writing (no partial edits, no "// ... rest unchanged")
- If the task is read-only (analysis, review, summary), just provide the summary without file operations
- Be precise, concise, and directly address the task
- If you cannot complete the task, explain why clearly`;

const llmExecutor: TaskExecutor = {
  async execute(context: TaskExecutionContext): Promise<TaskExecutionResult> {
    const { delegationId, workPath, task } = context;
    const startTime = Date.now();

    console.log(`[Executor] Task received: ${delegationId}`);
    console.log(`  Description: ${task.description}`);
    console.log(`  Model: ${MODEL}`);
    console.log(`  Workspace: ${workPath}`);

    const files = await walkDir(workPath, workPath);
    const fileCount = files.filter(f => !f.isDir).length;
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    console.log(`[Executor] Workspace: ${fileCount} files, ${formatSize(totalSize)}`);

    const workspaceContext = await buildWorkspaceContext(workPath, files);

    const userMessage = [
      `## Task\n\n**Description**: ${task.description}\n\n**Instructions**: ${task.prompt}`,
      '',
      `## Workspace\n\n${workspaceContext}`,
    ].join('\n');

    console.log(`[Executor] Calling ${MODEL}... (context: ~${(userMessage.length / 4).toFixed(0)} tokens)`);

    const llmResponse = await callLLM(SYSTEM_PROMPT, userMessage);
    const fileOps = parseFileOperations(llmResponse);
    const highlights: string[] = [`Analyzed ${fileCount} files (${formatSize(totalSize)})`];

    if (fileOps.length > 0) {
      console.log(`[Executor] Applying ${fileOps.length} file operation(s)...`);
      const results = await applyFileOperations(workPath, fileOps);
      highlights.push(...results);
    } else {
      highlights.push('No file modifications required');
    }

    const cleanSummary = llmResponse
      .replace(/<<<WRITE_FILE path="[^"]*">>>[\s\S]*?<<<\/WRITE_FILE>>>/g, '')
      .replace(/<<<DELETE_FILE path="[^"]*">>>/g, '')
      .trim();

    const elapsed = Date.now() - startTime;
    highlights.push(`Completed in ${(elapsed / 1000).toFixed(1)}s`);

    console.log(`[Executor] Task completed: ${delegationId} (${elapsed}ms, ${fileOps.length} file ops)`);

    return {
      summary: cleanSummary || `Task "${task.description}" completed.`,
      highlights,
    };
  },
};

async function main() {
  const app = express();

  app.get('/.well-known/agent-card.json', (_req, res) => {
    res.json(AGENT_CARD);
  });

  const awcp = await executorHandler({
    executor: llmExecutor,
    config: {
      workDir: WORK_DIR,
      transport: new ArchiveExecutorTransport(),
      admission: {
        maxConcurrentDelegations: 3,
        maxTtlSeconds: 3600,
        allowedAccessModes: ['ro', 'rw'],
      },
      hooks: {
        onTaskStart: (ctx) => {
          console.log(`[Executor] Task started: ${ctx.delegationId}`);
          console.log(`  Work path: ${ctx.workPath}`);
        },
        onTaskComplete: (id, summary) => {
          console.log(`[Executor] ✓ Task completed: ${id}`);
        },
        onError: (id, error) => {
          console.error(`[Executor] ✗ Task error: ${id}`, error.message);
        },
      },
    },
  });

  app.use('/awcp', awcp.router);

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      model: MODEL,
      uptime: process.uptime(),
    });
  });

  const server = createServer(app);

  server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║          AWCP Local LLM Executor                    ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  Model:      ${MODEL.padEnd(40)}║`);
    console.log(`║  Server:     http://localhost:${PORT}                   ║`);
    console.log(`║  AWCP:       http://localhost:${PORT}/awcp               ║`);
    console.log(`║  Agent Card: http://localhost:${PORT}/.well-known/       ║`);
    console.log(`║  Work Dir:   ${WORK_DIR.padEnd(40)}║`);
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Waiting for delegations...');
  });

  const shutdown = async () => {
    console.log('\n[Executor] Shutting down...');
    await awcp.shutdown();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Executor] Fatal error:', err);
  process.exit(1);
});
