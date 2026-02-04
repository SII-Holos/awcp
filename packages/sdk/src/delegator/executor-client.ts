/**
 * HTTP Client for sending AWCP messages to Executor
 */

import type { AwcpMessage, AcceptMessage, ErrorMessage, TaskEvent, TaskResultResponse } from '@awcp/core';

export type InviteResponse = AcceptMessage | ErrorMessage;

export interface ExecutorClientOptions {
  timeout?: number;
  sseMaxRetries?: number;
  sseRetryDelayMs?: number;
}

export class ExecutorClient {
  private timeout: number;
  private sseMaxRetries: number;
  private sseRetryDelayMs: number;

  constructor(options?: ExecutorClientOptions) {
    this.timeout = options?.timeout ?? 30000;
    this.sseMaxRetries = options?.sseMaxRetries ?? 3;
    this.sseRetryDelayMs = options?.sseRetryDelayMs ?? 2000;
  }

  /**
   * Send INVITE to Executor and get ACCEPT/ERROR response
   */
  async sendInvite(executorUrl: string, message: AwcpMessage): Promise<InviteResponse> {
    const response = await this.send(executorUrl, message);
    const data = await response.json();
    return data as InviteResponse;
  }

  /**
   * Send START to Executor (async, no response expected)
   */
  async sendStart(executorUrl: string, message: AwcpMessage): Promise<void> {
    await this.send(executorUrl, message);
  }

  /**
   * Subscribe to task events via SSE with retry
   */
  async *subscribeTask(executorUrl: string, delegationId: string): AsyncIterable<TaskEvent> {
    const baseUrl = executorUrl.replace(/\/$/, '').replace(/\/awcp$/, '');
    const url = `${baseUrl}/awcp/tasks/${delegationId}/events`;

    let retries = 0;
    while (retries < this.sseMaxRetries) {
      try {
        yield* this.readSSE(url);
        return;
      } catch (error) {
        retries++;
        if (retries >= this.sseMaxRetries) throw error;
        console.log(`[AWCP:Client] SSE retry ${retries}/${this.sseMaxRetries} for ${delegationId}`);
        await new Promise(r => setTimeout(r, this.sseRetryDelayMs * retries));
      }
    }
  }

  private async *readSSE(url: string): AsyncIterable<TaskEvent> {
    const response = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('SSE connection failed: no response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data) {
              try {
                const event = JSON.parse(data) as TaskEvent;
                yield event;
                if (event.type === 'done' || event.type === 'error') {
                  return;
                }
              } catch {
                // Ignore parse errors
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Request Executor to cancel a delegation
   */
  async sendCancel(executorUrl: string, delegationId: string): Promise<void> {
    const cancelUrl = executorUrl.replace(/\/$/, '') + `/cancel/${delegationId}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(cancelUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok && response.status !== 404) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to cancel delegation: ${response.status}${text ? ` - ${text}` : ''}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Fetch task result from Executor (for offline recovery)
   */
  async fetchResult(executorUrl: string, delegationId: string): Promise<TaskResultResponse> {
    const baseUrl = executorUrl.replace(/\/$/, '').replace(/\/awcp$/, '');
    const url = `${baseUrl}/awcp/tasks/${delegationId}/result`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      return await response.json() as TaskResultResponse;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Acknowledge result receipt to Executor
   */
  async acknowledgeResult(executorUrl: string, delegationId: string): Promise<void> {
    const baseUrl = executorUrl.replace(/\/$/, '').replace(/\/awcp$/, '');
    const url = `${baseUrl}/awcp/tasks/${delegationId}/ack`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async send(executorUrl: string, message: AwcpMessage): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(executorUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Failed to send ${message.type} to executor: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`
        );
      }

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
