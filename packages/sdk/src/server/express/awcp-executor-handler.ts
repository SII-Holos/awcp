/**
 * AWCP Executor Express Handler
 */

import { Router } from 'express';
import type { ListenerAdapter, ListenerInfo } from '../../listener/types.js';
import type { ExecutorConfig, TaskExecutor } from '../../executor/config.js';
import { ExecutorService } from '../../executor/service.js';
import { HttpListener } from '../../listener/http-listener.js';

export interface ExecutorHandlerOptions {
  executor: TaskExecutor;
  config: ExecutorConfig;
}

export interface ExecutorHandlerResult {
  router: Router;
  service: ExecutorService;
  listeners: ListenerAdapter[];
  getListenerInfos(): ListenerInfo[];
  shutdown(): Promise<void>;
}

export async function executorHandler(options: ExecutorHandlerOptions): Promise<ExecutorHandlerResult> {
  const { executor, config } = options;

  const service = new ExecutorService({ executor, config });
  await service.initialize();

  const listeners = config.listeners?.length ? config.listeners : [new HttpListener()];

  const listenerInfos: ListenerInfo[] = [];
  let httpRouter: Router | null = null;

  for (const listener of listeners) {
    const info = await listener.start(service, {
      onConnected: (info) => {
        console.log(`[AWCP:Executor] ${info.type} listener ready: ${info.publicUrl}`);
        config.hooks?.onListenerConnected?.(info);
      },
      onDisconnected: (error) => {
        console.log(`[AWCP:Executor] ${listener.type} listener disconnected`);
        config.hooks?.onListenerDisconnected?.(listener.type, error);
      },
      onError: (error) => {
        console.error(`[AWCP:Executor] ${listener.type} listener error:`, error);
      },
    });

    if (info) listenerInfos.push(info);

    if (listener instanceof HttpListener) {
      httpRouter = listener.getRouter();
    }
  }

  if (!httpRouter) {
    httpRouter = Router();
    httpRouter.get('/status', (_req, res) => {
      res.json({ status: 'ok', listeners: listenerInfos.map((l) => l.type) });
    });
  }

  return {
    router: httpRouter,
    service,
    listeners,
    getListenerInfos: () => [...listenerInfos],
    shutdown: async () => {
      await service.shutdown();
      for (const listener of listeners) {
        await listener.stop();
      }
    },
  };
}
