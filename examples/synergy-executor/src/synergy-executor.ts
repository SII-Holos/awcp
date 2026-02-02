/**
 * Synergy Executor
 * 
 * AgentExecutor implementation that delegates to Synergy AI coding agent.
 * When a workspace is mounted via AWCP, Synergy operates on those files.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Message } from '@a2a-js/sdk';
import type { AgentExecutor, RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';

// Default timeout for Synergy API calls (30 minutes for complex tasks)
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// Buffer time before lease expiry to ensure clean shutdown (30 seconds)
const LEASE_BUFFER_MS = 30 * 1000;

export interface AwcpContext {
  workPath: string;
  leaseExpiresAt?: Date;
  delegationId?: string;
}

export class SynergyExecutor implements AgentExecutor {
  private workingDirectory: string | null = null;
  private synergyUrl: string;
  private defaultTimeoutMs: number;
  private leaseExpiresAt: Date | null = null;
  private delegationId: string | null = null;

  constructor(synergyUrl = 'http://localhost:2026', defaultTimeoutMs = DEFAULT_TIMEOUT_MS) {
    this.synergyUrl = synergyUrl;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Set working directory with optional AWCP context (lease info)
   */
  setWorkingDirectory(dir: string, context?: Omit<AwcpContext, 'workPath'>): void {
    this.workingDirectory = dir;
    this.leaseExpiresAt = context?.leaseExpiresAt ?? null;
    this.delegationId = context?.delegationId ?? null;
    
    const timeoutInfo = this.leaseExpiresAt 
      ? `(lease expires: ${this.leaseExpiresAt.toISOString()})`
      : `(default timeout: ${this.defaultTimeoutMs / 1000}s)`;
    console.log(`[SynergyExecutor] Working directory set to: ${dir} ${timeoutInfo}`);
  }

  clearWorkingDirectory(): void {
    this.workingDirectory = null;
    this.leaseExpiresAt = null;
    this.delegationId = null;
    console.log(`[SynergyExecutor] Working directory cleared`);
  }

  /**
   * Calculate timeout based on lease expiry or default
   */
  private getTimeoutMs(): number {
    if (this.leaseExpiresAt) {
      const remainingMs = this.leaseExpiresAt.getTime() - Date.now() - LEASE_BUFFER_MS;
      if (remainingMs <= 0) {
        console.warn(`[SynergyExecutor] Lease already expired or expiring soon`);
        return 1000; // 1 second minimum
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

    const logPrefix = this.delegationId ? `[SynergyExecutor:${this.delegationId.slice(0, 8)}]` : '[SynergyExecutor]';
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
      const result = await this.executeWithSynergy(prompt);
      this.sendResponse(eventBus, ctx.contextId, result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[SynergyExecutor] Error:`, msg);
      this.sendResponse(eventBus, ctx.contextId, `Error: ${msg}`);
    }
  }

  cancelTask = async (): Promise<void> => {
    console.log(`[SynergyExecutor] Task cancelled`);
  };

  private async executeWithSynergy(prompt: string): Promise<string> {
    // Calculate timeout based on lease expiry or default
    const timeoutMs = this.getTimeoutMs();
    console.log(`[SynergyExecutor] Request timeout: ${Math.round(timeoutMs / 1000)}s`);

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Create session with working directory
      const sessionRes = await fetch(`${this.synergyUrl}/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-synergy-directory': this.workingDirectory!,
        },
        body: JSON.stringify({}),
        signal: controller.signal,
      });

      if (!sessionRes.ok) {
        throw new Error(`Failed to create Synergy session: ${sessionRes.status}`);
      }

      const session = await sessionRes.json() as { id: string };
      console.log(`[SynergyExecutor] Created session: ${session.id}`);

      // Send prompt and wait for response
      // Synergy API expects parts array: [{ type: 'text', text: '...' }]
      // Note: This can take a long time for complex tasks
      const promptRes = await fetch(`${this.synergyUrl}/session/${session.id}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-synergy-directory': this.workingDirectory!,
        },
        body: JSON.stringify({
          parts: [{ type: 'text', text: prompt }],
        }),
        signal: controller.signal,
      });

      if (!promptRes.ok) {
        throw new Error(`Failed to send prompt: ${promptRes.status}`);
      }

      const result = await promptRes.json() as { info: any; parts: any[] };
      console.log(`[SynergyExecutor] Got response with ${result.parts?.length || 0} parts`);

      // Extract text from response parts
      return this.extractResponseText(result);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutMs = this.getTimeoutMs();
        throw new Error(`Synergy request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private extractResponseText(result: { info: any; parts: any[] }): string {
    if (!result.parts || result.parts.length === 0) {
      return 'Task completed (no output)';
    }

    const textParts: string[] = [];

    for (const part of result.parts) {
      if (part.type === 'text' && part.text) {
        textParts.push(part.text);
      } else if (part.type === 'tool-invocation' && part.toolName) {
        // Summarize tool calls
        textParts.push(`[Tool: ${part.toolName}]`);
      }
    }

    return textParts.join('\n') || 'Task completed';
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
}
