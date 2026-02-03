/**
 * Listener Adapter Interface
 *
 * Connection layer abstraction for receiving requests.
 */

import type { ExecutorRequestHandler } from './service.js';

export interface ListenerInfo {
  type: string;
  publicUrl: string;
}

export interface ListenerCallbacks {
  onConnected?: (info: ListenerInfo) => void;
  onDisconnected?: (error?: Error) => void;
  onError?: (error: Error) => void;
}

/** Listener adapter for receiving Delegator requests */
export interface ListenerAdapter {
  readonly type: string;
  start(handler: ExecutorRequestHandler, callbacks?: ListenerCallbacks): Promise<ListenerInfo | null>;
  stop(): Promise<void>;
}
