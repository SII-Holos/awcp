/**
 * A2A HTTP Client
 * 
 * Simple HTTP client for sending A2A messages to other agents.
 */

import type { AwcpMessage } from '@awcp/core';
import { A2AMessage, A2AResponse, createA2AMessage } from './types.js';

export interface A2AClientConfig {
  /** This agent's URL (for sender identification) */
  selfUrl: string;
  /** Request timeout in ms */
  timeout?: number;
}

export class A2AClient {
  private selfUrl: string;
  private timeout: number;

  constructor(config: A2AClientConfig) {
    this.selfUrl = config.selfUrl;
    this.timeout = config.timeout ?? 30000;
  }

  /**
   * Send an AWCP message to another agent
   */
  async sendAwcpMessage(targetUrl: string, message: AwcpMessage): Promise<A2AResponse> {
    const a2aMessage = createA2AMessage(this.selfUrl, message);
    const endpoint = `${targetUrl}/a2a/message`;

    console.log(`[A2A Client] → Sending ${message.type} to ${targetUrl}`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(a2aMessage),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json() as A2AResponse;
      
      if (!result.accepted) {
        console.error(`[A2A Client] Message rejected: ${result.error}`);
      }

      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.timeout}ms`);
      }
      throw error;
    }
  }
}
