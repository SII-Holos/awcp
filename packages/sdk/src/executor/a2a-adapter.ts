/**
 * A2A SDK Adapter
 *
 * Wraps an A2A AgentExecutor to implement the TaskExecutor interface.
 */

import { randomUUID } from 'node:crypto';
import type { Message } from '@a2a-js/sdk';
import {
  DefaultExecutionEventBus,
  type AgentExecutor,
  type AgentExecutionEvent,
} from '@a2a-js/sdk/server';
import type { TaskExecutor, TaskExecutionContext, TaskExecutionResult } from './config.js';

export class A2ATaskExecutor implements TaskExecutor {
  private executor: AgentExecutor;

  constructor(executor: AgentExecutor) {
    this.executor = executor;
  }

  async execute(context: TaskExecutionContext): Promise<TaskExecutionResult> {
    const { workPath, task, environment } = context;

    const message: Message = {
      kind: 'message',
      messageId: randomUUID(),
      role: 'user',
      parts: [
        { kind: 'text', text: task.prompt },
        { kind: 'text', text: this.formatContext(workPath, task.description, environment) },
      ],
    };

    const taskId = randomUUID();
    const contextId = randomUUID();
    const requestContext = new RequestContextImpl(message, taskId, contextId);

    const eventBus = new DefaultExecutionEventBus();
    const results: Message[] = [];

    eventBus.on('event', (event: AgentExecutionEvent) => {
      if (event.kind === 'message') {
        results.push(event);
      }
    });

    await this.executor.execute(requestContext, eventBus);

    const summary = results
      .flatMap((m) => m.parts)
      .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
      .map((p) => p.text)
      .join('\n');

    return { summary: summary || 'Task completed' };
  }

  private formatContext(
    workPath: string,
    description: string,
    environment: TaskExecutionContext['environment'],
  ): string {
    const lines = ['', '[AWCP Context]', `Task: ${description}`, `Root: ${workPath}`, '', 'Resources:'];

    for (const resource of environment.resources) {
      lines.push(`  - ${resource.name}: ${workPath}/${resource.name} (${resource.mode})`);
    }

    if (environment.resources.length === 1) {
      lines.push('', `Working directory: ${workPath}/${environment.resources[0]!.name}`);
    }

    return lines.join('\n');
  }
}

class RequestContextImpl {
  readonly userMessage: Message;
  readonly taskId: string;
  readonly contextId: string;
  readonly task?: undefined;
  readonly referenceTasks?: undefined;
  readonly context?: undefined;

  constructor(userMessage: Message, taskId: string, contextId: string) {
    this.userMessage = userMessage;
    this.taskId = taskId;
    this.contextId = contextId;
  }
}
