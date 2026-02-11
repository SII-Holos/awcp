/**
 * WebSocket Tunnel Listener - Platform tunnel for NAT traversal
 */

import type { RawData } from 'ws';
import WebSocket from 'ws';
import type { TaskEvent } from '@awcp/core';
import type {
  ExecutorRequestHandler,
  ListenerAdapter,
  ListenerInfo,
  ListenerCallbacks,
} from './types.js';

export interface WebSocketTunnelConfig {
  server: string;
  token: string;
  reconnect?: {
    enabled?: boolean;
    maxRetries?: number;
    delayMs?: number;
  };
}

type TunnelClientMessage =
  | { type: 'AUTH'; token: string }
  | { type: 'HTTP_RESPONSE'; requestId: string; status: number; headers: Record<string, string>; body: string }
  | { type: 'SSE_EVENT'; streamId: string; data: string }
  | { type: 'SSE_END'; streamId: string };

type TunnelServerMessage =
  | { type: 'AUTH_OK'; publicUrl: string }
  | { type: 'AUTH_ERROR'; reason: string }
  | { type: 'HTTP_REQUEST'; requestId: string; method: string; path: string; headers: Record<string, string>; body?: string }
  | { type: 'SSE_OPEN'; streamId: string; path: string }
  | { type: 'SSE_CLOSE'; streamId: string }
  | { type: 'PING' };

const DEFAULT_RECONNECT = { enabled: true, maxRetries: 5, delayMs: 3000 } as const;

export class WebSocketTunnelListener implements ListenerAdapter {
  readonly type = 'websocket-tunnel';

  private config: WebSocketTunnelConfig;
  private ws: WebSocket | null = null;
  private handler: ExecutorRequestHandler | null = null;
  private callbacks: ListenerCallbacks | null = null;
  private sseStreams = new Map<string, () => void>();
  private publicUrl: string | null = null;
  private retryCount = 0;
  private stopped = false;

  constructor(config: WebSocketTunnelConfig) {
    this.config = config;
  }

  async start(handler: ExecutorRequestHandler, callbacks?: ListenerCallbacks): Promise<ListenerInfo> {
    this.handler = handler;
    this.callbacks = callbacks ?? null;
    this.stopped = false;
    return this.connect();
  }

  private connect(): Promise<ListenerInfo> {
    return new Promise((resolve, reject) => {
      console.log(`[AWCP:WsTunnel] Connecting to ${this.config.server}...`);
      this.ws = new WebSocket(this.config.server);

      this.ws.on('open', () => {
        console.log('[AWCP:WsTunnel] Connected, authenticating...');
        this.send({ type: 'AUTH', token: this.config.token });
      });

      this.ws.on('message', async (raw: RawData) => {
        try {
          const msg: TunnelServerMessage = JSON.parse(raw.toString());
          await this.handleMessage(msg, resolve, reject);
        } catch (error) {
          console.error('[AWCP:WsTunnel] Parse error:', error);
        }
      });

      this.ws.on('close', () => {
        console.log('[AWCP:WsTunnel] Disconnected');
        this.cleanupSseStreams();
        this.callbacks?.onDisconnected?.();
        if (!this.stopped) this.maybeReconnect();
      });

      this.ws.on('error', (error: Error) => {
        console.error('[AWCP:WsTunnel] Error:', error);
        if (!this.publicUrl) reject(error);
        else this.callbacks?.onError?.(error);
      });
    });
  }

  private async handleMessage(
    msg: TunnelServerMessage,
    resolve: (info: ListenerInfo) => void,
    reject: (error: Error) => void,
  ): Promise<void> {
    switch (msg.type) {
      case 'AUTH_OK':
        console.log(`[AWCP:WsTunnel] Authenticated: ${msg.publicUrl}`);
        this.publicUrl = msg.publicUrl;
        this.retryCount = 0;
        const info: ListenerInfo = { type: this.type, publicUrl: msg.publicUrl };
        this.callbacks?.onConnected?.(info);
        resolve(info);
        break;

      case 'AUTH_ERROR':
        const error = new Error(`Tunnel auth failed: ${msg.reason}`);
        this.callbacks?.onError?.(error);
        reject(error);
        break;

      case 'HTTP_REQUEST':
        await this.handleHttpRequest(msg);
        break;

      case 'SSE_OPEN':
        this.handleSseOpen(msg);
        break;

      case 'SSE_CLOSE':
        this.sseStreams.get(msg.streamId)?.();
        this.sseStreams.delete(msg.streamId);
        break;

      case 'PING':
        // TODO: Implement PONG if needed
        break;
    }
  }

  private async handleHttpRequest(req: Extract<TunnelServerMessage, { type: 'HTTP_REQUEST' }>): Promise<void> {
    if (!this.handler) return;

    try {
      const { response, status } = await this.routeRequest(req);
      this.send({
        type: 'HTTP_RESPONSE',
        requestId: req.requestId,
        status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(response),
      });
    } catch (error) {
      this.send({
        type: 'HTTP_RESPONSE',
        requestId: req.requestId,
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error instanceof Error ? error.message : 'Internal error' }),
      });
    }
  }

  private async routeRequest(req: { method: string; path: string; body?: string }): Promise<{ response: unknown; status: number }> {
    if (!this.handler) return { response: { error: 'Service unavailable' }, status: 503 };

    if (req.method === 'POST' && (req.path === '/' || req.path === '')) {
      const message = JSON.parse(req.body ?? '{}');
      const response = await this.handler.handleMessage(message);
      return { response: response ?? { ok: true }, status: 200 };
    }

    if (req.method === 'GET' && req.path === '/status') {
      return { response: this.handler.getStatus(), status: 200 };
    }

    const cancelMatch = req.path.match(/^\/cancel\/(.+)$/);
    if (req.method === 'POST' && cancelMatch) {
      try {
        await this.handler.cancelDelegation(cancelMatch[1]!);
        return { response: { ok: true, cancelled: true }, status: 200 };
      } catch (error) {
        const notFound = error instanceof Error && error.message.includes('not found');
        return { response: { error: error instanceof Error ? error.message : 'Internal error' }, status: notFound ? 404 : 500 };
      }
    }

    return { response: { error: 'Not found' }, status: 404 };
  }

  private handleSseOpen(req: Extract<TunnelServerMessage, { type: 'SSE_OPEN' }>): void {
    if (!this.handler) return;

    const match = req.path.match(/^\/tasks\/([^/]+)\/events$/);
    if (!match) {
      this.send({ type: 'SSE_END', streamId: req.streamId });
      return;
    }

    const unsubscribe = this.handler.subscribeTask(match[1]!, (event: TaskEvent) => {
      this.send({ type: 'SSE_EVENT', streamId: req.streamId, data: JSON.stringify(event) });
      if (event.type === 'done' || event.type === 'error') {
        this.send({ type: 'SSE_END', streamId: req.streamId });
        this.sseStreams.delete(req.streamId);
      }
    });

    this.sseStreams.set(req.streamId, unsubscribe);
  }

  private cleanupSseStreams(): void {
    for (const unsub of this.sseStreams.values()) unsub();
    this.sseStreams.clear();
  }

  private maybeReconnect(): void {
    const cfg = { ...DEFAULT_RECONNECT, ...this.config.reconnect };
    if (!cfg.enabled || this.retryCount >= cfg.maxRetries) {
      if (this.retryCount >= cfg.maxRetries) {
        this.callbacks?.onError?.(new Error('Max reconnect retries reached'));
      }
      return;
    }

    this.retryCount++;
    const delay = cfg.delayMs * this.retryCount;
    console.log(`[AWCP:WsTunnel] Reconnecting in ${delay}ms (${this.retryCount}/${cfg.maxRetries})...`);

    setTimeout(() => {
      if (!this.stopped) this.connect().catch(console.error);
    }, delay);
  }

  private send(msg: TunnelClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cleanupSseStreams();
    this.ws?.close();
    this.ws = null;
    this.handler = null;
    this.publicUrl = null;
  }
}
