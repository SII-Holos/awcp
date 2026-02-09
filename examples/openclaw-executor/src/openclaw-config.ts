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

  // SII API provider (优先级最高)
  if (process.env.SII_API_KEY) {
    const siiModel = process.env.SII_MODEL || 'sonnet';
    
    config.models = {
      mode: 'merge',
      providers: {
        'sii-anthropic': {
          baseUrl: 'http://apicz.boyuerichdata.com/v1',
          apiKey: '${SII_API_KEY}',
          api: 'openai-completions',
          models: [
            {
              id: 'claude-haiku-4-5-20251001-thinking',
              name: 'Haiku 4.5',
              contextWindow: 200000,
              maxTokens: 64000,
            },
            {
              id: 'claude-sonnet-4-5-20250929-thinking',
              name: 'Sonnet 4.5',
              contextWindow: 200000,
              maxTokens: 64000,
            },
            {
              id: 'claude-opus-4-5-20251101-thinking',
              name: 'Opus 4.5',
              contextWindow: 200000,
              maxTokens: 64000,
            },
          ],
        },
        'sii-openai': {
          baseUrl: 'http://apicz.boyuerichdata.com/v1',
          apiKey: '${SII_API_KEY}',
          api: 'openai-completions',
          models: [
            {
              id: 'gpt-4.1-nano',
              name: 'GPT-4.1-nano',
              contextWindow: 1000000,
              maxTokens: 32768,
            },
            {
              id: 'gpt-5.2',
              name: 'GPT-5.2',
              contextWindow: 400000,
              maxTokens: 128000,
            },
          ],
        },
        'sii-google': {
          baseUrl: 'http://apicz.boyuerichdata.com/v1beta',
          apiKey: '${SII_API_KEY}',
          api: 'openai-completions',
          models: [
            {
              id: 'gemini-3-pro-preview-thinking',
              name: 'Gemini 3 Pro',
              contextWindow: 1000000,
              maxTokens: 64000,
            },
            {
              id: 'gemini-3-flash-preview-thinking',
              name: 'Gemini 3 Flash',
              contextWindow: 1000000,
              maxTokens: 64000,
            },
          ],
        },
      },
    };

    // 根据 SII_MODEL 环境变量选择模型
    const modelMap: Record<string, string> = {
      'haiku': 'sii-anthropic/claude-haiku-4-5-20251001-thinking',
      'sonnet': 'sii-anthropic/claude-sonnet-4-5-20250929-thinking',
      'opus': 'sii-anthropic/claude-opus-4-5-20251101-thinking',
      'gpt-nano': 'sii-openai/gpt-4.1-nano',
      'gpt-5': 'sii-openai/gpt-5.2',
      'gemini-pro': 'sii-google/gemini-3-pro-preview-thinking',
      'gemini-flash': 'sii-google/gemini-3-flash-preview-thinking',
    };
    config.agents.defaults.model = { primary: modelMap[siiModel] || modelMap['sonnet']! };
    
    console.log(`[OpenClaw Config] Using SII provider with model: ${config.agents.defaults.model.primary}`);
  }
  // SII Nex provider
  else if (process.env.SII_NEX_API_KEY) {
    config.models = {
      mode: 'merge',
      providers: {
        'sii-nex': {
          baseUrl: 'https://nex-deepseek.openapi-qb-ai.sii.edu.cn/v1',
          apiKey: '${SII_NEX_API_KEY}',
          api: 'openai-completions',
          models: [
            {
              id: 'nex-agi/nex-n1',
              name: 'Nex N1',
              contextWindow: 128000,
              maxTokens: 32000,
            },
          ],
        },
      },
    };
    config.agents.defaults.model = { primary: 'sii-nex/nex-agi/nex-n1' };
  }
  // DeepSeek
  else if (process.env.DEEPSEEK_API_KEY) {
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
