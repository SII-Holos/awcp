/**
 * Synergy Executor
 * 
 * AgentExecutor implementation that delegates to Synergy AI coding agent.
 * When a workspace is mounted via AWCP, Synergy operates on those files.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Message } from '@a2a-js/sdk';
import type { AgentExecutor, RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';

export class SynergyExecutor implements AgentExecutor {
  private workingDirectory: string | null = null;
  private synergyUrl: string;

  constructor(synergyUrl = 'http://localhost:2026') {
    this.synergyUrl = synergyUrl;
  }

  setWorkingDirectory(dir: string): void {
    this.workingDirectory = dir;
    console.log(`[SynergyExecutor] Working directory set to: ${dir}`);
  }

  clearWorkingDirectory(): void {
    this.workingDirectory = null;
    console.log(`[SynergyExecutor] Working directory cleared`);
  }

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    let prompt = '';
    for (const part of ctx.userMessage.parts) {
      if (part.kind === 'text') {
        prompt += part.text;
      }
    }

    console.log(`[SynergyExecutor] Received task: ${prompt.slice(0, 100)}...`);

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
    // Create session with working directory
    const sessionRes = await fetch(`${this.synergyUrl}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-synergy-directory': this.workingDirectory!,
      },
      body: JSON.stringify({}),
    });

    if (!sessionRes.ok) {
      throw new Error(`Failed to create Synergy session: ${sessionRes.status}`);
    }

    const session = await sessionRes.json() as { id: string };
    console.log(`[SynergyExecutor] Created session: ${session.id}`);

    // Send prompt and wait for response
    // Synergy API expects parts array: [{ type: 'text', text: '...' }]
    const promptRes = await fetch(`${this.synergyUrl}/session/${session.id}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-synergy-directory': this.workingDirectory!,
      },
      body: JSON.stringify({
        parts: [{ type: 'text', text: prompt }],
      }),
    });

    if (!promptRes.ok) {
      throw new Error(`Failed to send prompt: ${promptRes.status}`);
    }

    const result = await promptRes.json() as { info: any; parts: any[] };
    console.log(`[SynergyExecutor] Got response with ${result.parts?.length || 0} parts`);

    // Extract text from response parts
    return this.extractResponseText(result);
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
