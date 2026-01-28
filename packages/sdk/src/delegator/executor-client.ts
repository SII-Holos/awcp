/**
 * HTTP Client for sending AWCP messages to Executor
 */

import type { AwcpMessage, AcceptMessage, ErrorMessage } from '@awcp/core';

/**
 * Response from Executor for INVITE message
 */
export type InviteResponse = AcceptMessage | ErrorMessage;

/**
 * Client for sending AWCP messages to Executor daemon
 */
export class ExecutorClient {
  private timeout: number;
  private callbackUrl: string;

  constructor(options: { timeout?: number; callbackUrl: string }) {
    this.timeout = options.timeout ?? 30000;
    this.callbackUrl = options.callbackUrl;
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
   * Send ERROR/CANCEL to Executor
   */
  async sendError(executorUrl: string, message: AwcpMessage): Promise<void> {
    await this.send(executorUrl, message);
  }

  /**
   * Internal send method
   */
  private async send(executorUrl: string, message: AwcpMessage): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(executorUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AWCP-Callback-URL': this.callbackUrl,
        },
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
