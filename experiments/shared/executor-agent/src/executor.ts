/**
 * File Operations Executor
 * 
 * Executes file operations in the mounted workspace.
 * This is a simple executor that can read, write, and append to files.
 */

import { readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { Message } from '@a2a-js/sdk';
import type { AgentExecutor, RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';

/**
 * File operation executor
 * 
 * Understands simple commands:
 * - "read <file>" - Read file contents
 * - "append <file> <content>" - Append to file
 * - "write <file> <content>" - Overwrite file
 * - "list" - List files in workspace
 */
export class FileOperationExecutor implements AgentExecutor {
  private workingDirectory: string | null = null;

  /**
   * Set the working directory (called when AWCP mounts workspace)
   */
  setWorkingDirectory(dir: string): void {
    this.workingDirectory = dir;
    console.log(`[Executor] Working directory set to: ${dir}`);
  }

  /**
   * Clear the working directory (called when AWCP unmounts)
   */
  clearWorkingDirectory(): void {
    this.workingDirectory = null;
    console.log(`[Executor] Working directory cleared`);
  }

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userMessage = ctx.userMessage;
    let prompt = '';

    for (const part of userMessage.parts) {
      if (part.kind === 'text') {
        prompt += part.text;
      }
    }

    console.log(`[Executor] Received task: ${prompt}`);

    // Check if we have a working directory
    if (!this.workingDirectory) {
      const response: Message = {
        kind: 'message',
        messageId: uuidv4(),
        role: 'agent',
        parts: [{ kind: 'text', text: 'No workspace mounted. This executor requires AWCP delegation.' }],
        contextId: ctx.contextId,
      };
      eventBus.publish(response);
      eventBus.finished();
      return;
    }

    try {
      const result = await this.processCommand(prompt);
      
      const response: Message = {
        kind: 'message',
        messageId: uuidv4(),
        role: 'agent',
        parts: [{ kind: 'text', text: result }],
        contextId: ctx.contextId,
      };
      eventBus.publish(response);
      eventBus.finished();
    } catch (error) {
      const response: Message = {
        kind: 'message',
        messageId: uuidv4(),
        role: 'agent',
        parts: [{ kind: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        contextId: ctx.contextId,
      };
      eventBus.publish(response);
      eventBus.finished();
    }
  }

  cancelTask = async (): Promise<void> => {};

  private async processCommand(prompt: string): Promise<string> {
    const lines = prompt.trim().split('\n');
    const results: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Parse command
      if (trimmed.toLowerCase().startsWith('read ')) {
        const filename = trimmed.slice(5).trim();
        const result = await this.readFileOp(filename);
        results.push(result);
      } else if (trimmed.toLowerCase().startsWith('append ')) {
        const rest = trimmed.slice(7).trim();
        const spaceIdx = rest.indexOf(' ');
        if (spaceIdx === -1) {
          results.push(`Error: append requires filename and content`);
        } else {
          const filename = rest.slice(0, spaceIdx);
          const content = rest.slice(spaceIdx + 1);
          const result = await this.appendToFile(filename, content);
          results.push(result);
        }
      } else if (trimmed.toLowerCase().startsWith('write ')) {
        const rest = trimmed.slice(6).trim();
        const spaceIdx = rest.indexOf(' ');
        if (spaceIdx === -1) {
          results.push(`Error: write requires filename and content`);
        } else {
          const filename = rest.slice(0, spaceIdx);
          const content = rest.slice(spaceIdx + 1);
          const result = await this.writeToFile(filename, content);
          results.push(result);
        }
      } else if (trimmed.toLowerCase() === 'list') {
        const result = await this.listFiles();
        results.push(result);
      } else {
        // Default: try to understand natural language
        const result = await this.processNaturalLanguage(trimmed);
        results.push(result);
      }
    }

    return results.join('\n');
  }

  private async readFileOp(filename: string): Promise<string> {
    const filepath = join(this.workingDirectory!, filename);
    console.log(`[Executor] Reading file: ${filepath}`);
    const content = await readFile(filepath, 'utf-8');
    return `Contents of ${filename}:\n${content}`;
  }

  private async appendToFile(filename: string, content: string): Promise<string> {
    const filepath = join(this.workingDirectory!, filename);
    console.log(`[Executor] Appending to file: ${filepath}`);
    await appendFile(filepath, content + '\n', 'utf-8');
    return `Appended to ${filename}: "${content}"`;
  }

  private async writeToFile(filename: string, content: string): Promise<string> {
    const filepath = join(this.workingDirectory!, filename);
    console.log(`[Executor] Writing to file: ${filepath}`);
    await writeFile(filepath, content + '\n', 'utf-8');
    return `Wrote to ${filename}: "${content}"`;
  }

  private async listFiles(): Promise<string> {
    console.log(`[Executor] Listing files in: ${this.workingDirectory}`);
    const entries = await readdir(this.workingDirectory!, { withFileTypes: true });
    const files = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name);
    return `Files in workspace:\n${files.map(f => `  - ${f}`).join('\n')}`;
  }

  private async processNaturalLanguage(prompt: string): Promise<string> {
    const lower = prompt.toLowerCase();
    
    // Try to understand natural language commands
    if (lower.includes('add') && lower.includes('line')) {
      // "add a line to hello.txt saying Hello World"
      const files = await readdir(this.workingDirectory!);
      const targetFile = files.find(f => lower.includes(f.toLowerCase())) || files[0];
      
      if (!targetFile) {
        return 'No files found in workspace';
      }

      // Extract content after common phrases
      let content = 'Hello from AWCP Executor!';
      const sayingMatch = prompt.match(/saying [""']?(.+?)[""']?$/i);
      const withMatch = prompt.match(/with [""']?(.+?)[""']?$/i);
      if (sayingMatch) content = sayingMatch[1]!;
      else if (withMatch) content = withMatch[1]!;

      return await this.appendToFile(targetFile, content);
    }

    if (lower.includes('read') || lower.includes('show') || lower.includes('contents')) {
      const files = await readdir(this.workingDirectory!);
      const targetFile = files.find(f => lower.includes(f.toLowerCase())) || files[0];
      
      if (!targetFile) {
        return 'No files found in workspace';
      }
      
      return await this.readFileOp(targetFile);
    }

    if (lower.includes('list') || lower.includes('files')) {
      return await this.listFiles();
    }

    // Default: list files and read first one
    const listResult = await this.listFiles();
    return `I understand your request: "${prompt}"\n\n${listResult}\n\nTip: Use commands like "read <file>", "append <file> <content>", or "list"`;
  }
}
