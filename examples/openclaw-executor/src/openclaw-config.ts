/**
 * OpenClaw Configuration
 *
 * Configuration specific to OpenClaw Gateway integration.
 * This handles model provider setup and gateway lifecycle.
 */

import path from 'node:path';
import type { AppConfig } from './app-config.js';

export interface OpenClawConfig {
  /** OpenClaw Gateway port */
  gatewayPort: number;
  /** OpenClaw Gateway URL */
  gatewayUrl: string;
  /** Gateway authentication token */
  gatewayToken: string;
  /** OpenClaw state directory */
  stateDir: string;
}

export function loadOpenClawConfig(appConfig: AppConfig): OpenClawConfig {
  const gatewayPort = parseInt(process.env.OPENCLAW_PORT || '18789', 10);
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || generateToken();
  const gatewayUrl = process.env.OPENCLAW_URL || `http://127.0.0.1:${gatewayPort}`;

  return {
    gatewayPort,
    gatewayUrl,
    gatewayToken,
    stateDir: path.join(appConfig.dataDir, '.openclaw'),
  };
}

function generateToken(): string {
  return 'awcp-' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

/**
 * OpenClaw Gateway configuration file structure.
 * This is written to openclaw.json for the gateway to read.
 */
export interface OpenClawGatewayConfig {
  gateway: {
    port: number;
    auth: {
      mode: 'token';
      token: string;
    };
    http: {
      endpoints: {
        chatCompletions: { enabled: boolean };
      };
    };
  };
  models?: {
    mode: 'merge';
    providers: Record<string, OpenClawProviderConfig>;
  };
  agents: {
    defaults: {
      workspace: string;
      skipBootstrap: boolean;
      model?: { primary: string };
    };
  };
  tools: {
    profile: string;
  };
}

export interface OpenClawProviderConfig {
  baseUrl: string;
  apiKey: string;
  api: string;
  models: Array<{
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
  }>;
}

/**
 * Generate OpenClaw Gateway configuration based on available API keys.
 */
export function generateGatewayConfig(
  openclawConfig: OpenClawConfig,
  workspace: string
): OpenClawGatewayConfig {
  const config: OpenClawGatewayConfig = {
    gateway: {
      port: openclawConfig.gatewayPort,
      auth: {
        mode: 'token',
        token: openclawConfig.gatewayToken,
      },
      http: {
        endpoints: {
          chatCompletions: { enabled: true },
        },
      },
    },
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
      },
    },
    tools: {
      profile: 'coding',
    },
  };

  // Auto-configure model provider based on available API keys
  if (process.env.DEEPSEEK_API_KEY) {
    config.models = {
      mode: 'merge',
      providers: {
        deepseek: {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: '${DEEPSEEK_API_KEY}',
          api: 'openai-completions',
          models: [
            {
              id: 'deepseek-chat',
              name: 'DeepSeek Chat',
              contextWindow: 64000,
              maxTokens: 8192,
            },
          ],
        },
      },
    };
    config.agents.defaults.model = { primary: 'deepseek/deepseek-chat' };
  } else if (process.env.OPENROUTER_API_KEY) {
    config.models = {
      mode: 'merge',
      providers: {
        openrouter: {
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: '${OPENROUTER_API_KEY}',
          api: 'openai-completions',
          models: [
            {
              id: 'anthropic/claude-sonnet-4',
              name: 'Claude Sonnet 4',
              contextWindow: 200000,
              maxTokens: 8192,
            },
          ],
        },
      },
    };
    config.agents.defaults.model = { primary: 'openrouter/anthropic/claude-sonnet-4' };
  }
  // ANTHROPIC_API_KEY and OPENAI_API_KEY are natively supported by OpenClaw

  return config;
}
