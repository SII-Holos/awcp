/**
 * HTTP Client for sending AWCP messages to Executor
 */

import type { AwcpMessage, AcceptMessage, ErrorMessage, TaskEvent } from '@awcp/core';

export type InviteResponse = AcceptMessage | ErrorMessage;

export interface TaskEventStream {
  events: AsyncIterable<TaskEvent>;
  abort: () => void;
}

export class ExecutorClient {
  private timeout: number;
  private sseMaxRetries: number;
  private sseRetryDelayMs: number;

  constructor(options?: ExecutorClientOptions) {
    this.timeout = options?.timeout ?? 300000; // 5 minutes for large transfers
    this.sseMaxRetries = options?.sseMaxRetries ?? 3;
    this.sseRetryDelayMs = options?.sseRetryDelayMs ?? 2000;
  }

  async sendInvite(executorUrl: string, message: AwcpMessage): Promise<InviteResponse> {
    const response = await this.send(executorUrl, message);
    const data = await response.json();
    return data as InviteResponse;
  }

  async sendStart(executorUrl: string, message: AwcpMessage): Promise<void> {
    await this.send(executorUrl, message);
  }

  /**
   * Establish SSE connection with retry. Resolves once connected.
   */
  async connectTaskEvents(executorUrl: string, delegationId: string): Promise<TaskEventStream> {
    const baseUrl = executorUrl.replace(/\/$/, '').replace(/\/awcp$/, '');
    const url = `${baseUrl}/awcp/tasks/${delegationId}/events`;
    const controller = new AbortController();

    let retries = 0;
    while (retries < this.sseMaxRetries) {
      try {
        console.log(`[AWCP:Client] SSE connecting to ${url} (attempt ${retries + 1}/${this.sseMaxRetries})`);
        const response = await fetch(url, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error('SSE connection failed: no response body');
        }

        console.log(`[AWCP:Client] SSE connected for ${delegationId}`);
        return {
          events: this.parseSSEStream(response.body),
          abort: () => controller.abort(),
        };
      } catch (error) {
        retries++;
        const msg = error instanceof Error ? error.message : String(error);
        if (retries >= this.sseMaxRetries || controller.signal.aborted) {
          console.error(`[AWCP:Client] SSE failed after ${retries} attempts for ${delegationId}: ${msg}`);
          throw error;
        }
        const delayMs = this.sseRetryDelayMs * retries;
        console.warn(`[AWCP:Client] SSE attempt ${retries} failed for ${delegationId}: ${msg}, retrying in ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    throw new Error(`SSE connection failed after ${this.sseMaxRetries} attempts`);
  }

  private async *parseSSEStream(body: ReadableStream<Uint8Array>): AsyncIterable<TaskEvent> {
    const reader = body.getReader();
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
