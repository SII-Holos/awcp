/**
 * OpenClaw Executor
 *
 * AgentExecutor implementation that delegates to OpenClaw AI assistant.
 * When a workspace is mounted via AWCP, OpenClaw operates on those files.
 */

import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Message } from '@a2a-js/sdk';
import type { AgentExecutor, RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';
import { OpenClawHttpClient, type StreamChunk } from './http-client.js';
import type { OpenClawGatewayManager } from './gateway-manager.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const LEASE_BUFFER_MS = 30 * 1000;

export interface AwcpContext {
  workPath: string;
  leaseExpiresAt?: Date;
  delegationId?: string;
  taskId?: string;
}

const SYSTEM_PROMPT = `You are an AI coding assistant executing a delegated task.

IMPORTANT INSTRUCTIONS:
1. You are working in a delegated workspace provided by the AWCP (Agent Workspace Collaboration Protocol).
2. Complete the task described in the user message.
3. Make all necessary file changes directly in the current workspace.
4. When done, provide a brief summary of what you accomplished.

WORKSPACE RULES:
- All file operations should be relative to the current working directory.
- Do not ask for clarification - make reasonable assumptions and proceed.
- Focus on completing the task efficiently and correctly.
`;

export class OpenClawExecutor implements AgentExecutor {
  private client: OpenClawHttpClient;
  private workingDirectory: string | null = null;
  private leaseExpiresAt: Date | null = null;
  private delegationId: string | null = null;
  private defaultTimeoutMs: number;

  constructor(
    gatewayManager: OpenClawGatewayManager,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.client = new OpenClawHttpClient({
      baseUrl: gatewayManager.gatewayUrl,
      token: gatewayManager.gatewayToken,
      agentId: 'main',
    });
  }

  setWorkingDirectory(dir: string, context?: Omit<AwcpContext, 'workPath'>): void {
    this.workingDirectory = dir;
    this.leaseExpiresAt = context?.leaseExpiresAt ?? null;
    this.delegationId = context?.delegationId ?? null;

    const timeoutInfo = this.leaseExpiresAt
      ? `(lease expires: ${this.leaseExpiresAt.toISOString()})`
      : `(default timeout: ${this.defaultTimeoutMs / 1000}s)`;
    console.log(`[OpenClawExecutor] Working directory set to: ${dir} ${timeoutInfo}`);
  }

  clearWorkingDirectory(): void {
    this.workingDirectory = null;
    this.leaseExpiresAt = null;
    this.delegationId = null;
    console.log(`[OpenClawExecutor] Working directory cleared`);
  }

  private getTimeoutMs(): number {
    if (this.leaseExpiresAt) {
      const remainingMs = this.leaseExpiresAt.getTime() - Date.now() - LEASE_BUFFER_MS;
      if (remainingMs <= 0) {
        console.warn(`[OpenClawExecutor] Lease already expired or expiring soon`);
        return 1000;
      }
      return remainingMs;
    }
    return this.defaultTimeoutMs;
  }

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    let prompt = '';
    for (const part of ctx.userMessage.parts) {
      if (part.kind === 'text') {
        prompt += part.text;
      }
    }

    const logPrefix = this.delegationId
      ? `[OpenClawExecutor:${this.delegationId.slice(0, 8)}]`
      : '[OpenClawExecutor]';
    console.log(`${logPrefix} Received task: ${prompt.slice(0, 100)}...`);

    if (!this.workingDirectory) {
      this.sendResponse(
        eventBus,
        ctx.contextId,
        'No workspace mounted. This executor requires AWCP delegation with a workspace.'
      );
      return;
    }

    try {
      const result = await this.executeWithOpenClaw(prompt);
      this.sendResponse(eventBus, ctx.contextId, result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`${logPrefix} Error:`, msg);
      this.sendResponse(eventBus, ctx.contextId, `Error: ${msg}`);
    }
  }

  cancelTask = async (): Promise<void> => {
    console.log(`[OpenClawExecutor] Task cancelled`);
  };

  private async executeWithOpenClaw(prompt: string): Promise<string> {
    const timeoutMs = this.getTimeoutMs();
    console.log(`[OpenClawExecutor] Request timeout: ${Math.round(timeoutMs / 1000)}s`);

    await this.injectAgentsMd(this.workingDirectory!, prompt);

    const sessionKey = this.delegationId ? `awcp:${this.delegationId}` : `awcp:${uuidv4()}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let fullResponse = '';

      await this.client.chatCompletionStream(
        {
          model: 'openclaw:main',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: this.formatPrompt(prompt, this.workingDirectory!) },
          ],
          user: sessionKey,
        },
        (chunk: StreamChunk) => {
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) {
            fullResponse += content;
          }
        },
      );

      console.log(`[OpenClawExecutor] Task completed. Response length: ${fullResponse.length}`);
      return fullResponse || 'Task completed (no output)';
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`OpenClaw request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private formatPrompt(prompt: string, workDir: string): string {
    return `
## Task
${prompt}

## Workspace
Working directory: ${workDir}

Please complete this task. Make all necessary changes to the codebase.
When finished, provide a brief summary of what you accomplished.
`.trim();
  }

  private async injectAgentsMd(workDir: string, prompt: string): Promise<void> {
    const agentsMdPath = path.join(workDir, 'AGENTS.md');
    const content = `# AWCP Delegation Task

## Task Instructions
${prompt}

## Working Directory
All file operations should be performed relative to this directory.

## Guidelines
- Complete the task as described above
- Make necessary file changes directly
- Provide a summary when done
`;

    try {
      await fs.writeFile(agentsMdPath, content, 'utf-8');
      console.log(`[OpenClawExecutor] Injected AGENTS.md at ${agentsMdPath}`);
    } catch (error) {
      console.warn(`[OpenClawExecutor] Failed to inject AGENTS.md:`, error);
    }
  }

  private sendResponse(eventBus: ExecutionEventBus, contextId: string, text: string): void {
    const response: Message = {
      kind: 'message',
      messageId: uuidv4(),
      role: 'agent',
      parts: [{ kind: 'text', text }],
      contextId,
    };
    eventBus.publish(response);
    eventBus.finished();
  }

  get context(): AwcpContext | null {
    if (!this.workingDirectory) return null;
    return {
      workPath: this.workingDirectory,
      leaseExpiresAt: this.leaseExpiresAt ?? undefined,
      delegationId: this.delegationId ?? undefined,
    };
  }
}
