/**
 * ExecutorClient Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExecutorClient } from '../../src/delegator/executor-client.js';

function createMockSSEResponse(events: Array<{ type: string; data?: any }>) {
  let eventIndex = 0;

  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (eventIndex >= events.length) {
            return { done: true, value: undefined };
          }
          const event = events[eventIndex++]!;
          const data = `data: ${JSON.stringify({ type: event.type, ...event.data })}\n\n`;
          return { done: false, value: new TextEncoder().encode(data) };
        },
        releaseLock: () => {},
      }),
    },
  };
}

describe('ExecutorClient', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // Use short retry delay for tests
  const testClient = () => new ExecutorClient({ sseRetryDelayMs: 10 });

  describe('subscribeTask', () => {
    it('should receive events successfully', async () => {
      const events = [
        { type: 'status', data: { status: 'running' } },
        { type: 'done', data: { summary: 'completed' } },
      ];

      global.fetch = vi.fn().mockResolvedValue(createMockSSEResponse(events));

      const client = testClient();
      const received: any[] = [];

      for await (const event of client.subscribeTask('http://localhost/awcp', 'test-id')) {
        received.push(event);
      }

      expect(received).toHaveLength(2);
      expect(received[0].type).toBe('status');
      expect(received[1].type).toBe('done');
    });

    it('should retry on connection failure', async () => {
      let attempt = 0;
      const events = [
        { type: 'status', data: { status: 'running' } },
        { type: 'done', data: { summary: 'completed' } },
      ];

      global.fetch = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt < 3) {
          throw new Error('Network error');
        }
        return createMockSSEResponse(events);
      });

      const client = testClient();
      const received: any[] = [];

      for await (const event of client.subscribeTask('http://localhost/awcp', 'test-id')) {
        received.push(event);
      }

      expect(attempt).toBe(3);
      expect(received).toHaveLength(2);
    });

    it('should fail after max retries', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const client = testClient();

      await expect(async () => {
        for await (const _ of client.subscribeTask('http://localhost/awcp', 'test-id')) {
          // consume
        }
      }).rejects.toThrow('Network error');

      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('should not retry after receiving done event', async () => {
      const events = [{ type: 'done', data: { summary: 'completed' } }];
      global.fetch = vi.fn().mockResolvedValue(createMockSSEResponse(events));

      const client = testClient();
      const received: any[] = [];

      for await (const event of client.subscribeTask('http://localhost/awcp', 'test-id')) {
        received.push(event);
      }

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(received).toHaveLength(1);
    });

    it('should handle HTTP error response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const client = testClient();

      await expect(async () => {
        for await (const _ of client.subscribeTask('http://localhost/awcp', 'test-id')) {
          // consume
        }
      }).rejects.toThrow('SSE connection failed: 404 Not Found');
    });
  });
});
