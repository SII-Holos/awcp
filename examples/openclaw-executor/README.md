# OpenClaw Executor

AWCP Executor powered by [OpenClaw](https://github.com/anthropics/openclaw) - an open-source AI coding assistant.

This example demonstrates how to integrate an AI assistant with the Agent Workspace Collaboration Protocol (AWCP).

## Quick Start

```bash
# 1. Install OpenClaw
npm install -g openclaw@latest

# 2. Set your API key
export DEEPSEEK_API_KEY="sk-xxx"
# or: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY

# 3. Run the executor
./run.sh
```

The executor will start on `http://localhost:10200` with:
- **A2A endpoint**: `/a2a` - Agent-to-Agent protocol
- **AWCP endpoint**: `/awcp` - Workspace delegation protocol
- **Agent Card**: `/.well-known/agent-card.json`

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                     OpenClaw Executor                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌───────────────┐    ┌───────────────────────────────────┐   │
│   │ Express Server│    │ OpenClaw Gateway                  │   │
│   │               │    │                                   │   │
│   │ • A2A         │───►│ • OpenAI-compatible HTTP API      │   │
│   │ • AWCP        │    │ • SSE streaming                   │   │
│   │ • Health      │    │ • Tool execution                  │   │
│   └───────────────┘    └───────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

When a Delegator sends work:

1. **INVITE** → Executor receives task description
2. **ACCEPT** → Executor agrees to take the task
3. **START** → Workspace files are transferred
4. **Execute** → OpenClaw processes the task
5. **DONE** → Results are returned to Delegator

## Project Structure

```
src/
├── agent.ts           # Main entry point
├── app-config.ts      # Application configuration
├── openclaw-config.ts # OpenClaw-specific configuration
├── awcp-config.ts     # AWCP protocol configuration (standard pattern)
├── gateway-manager.ts # OpenClaw Gateway lifecycle
├── openclaw-executor.ts # AgentExecutor implementation
├── http-client.ts     # OpenClaw HTTP API client
└── agent-card.ts      # A2A Agent Card definition
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `10200` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server bind address |
| `OPENCLAW_PORT` | `18789` | OpenClaw Gateway port |
| `AWCP_TRANSPORT` | `archive` | File transport (`archive` or `sshfs`) |

### API Keys

The executor auto-configures the model provider based on available API keys:

| Key | Provider | Model |
|-----|----------|-------|
| `DEEPSEEK_API_KEY` | DeepSeek | deepseek-chat |
| `OPENROUTER_API_KEY` | OpenRouter | claude-sonnet-4 |
| `ANTHROPIC_API_KEY` | Anthropic | (OpenClaw default) |
| `OPENAI_API_KEY` | OpenAI | (OpenClaw default) |

## Integrating Your Own AI Assistant

This example shows the standard pattern for AWCP integration. Key files to study:

### `awcp-config.ts` - AWCP Configuration

```typescript
// Standard AWCP configuration - same pattern for any AI assistant
export function createAwcpConfig(...): ExecutorConfig {
  return {
    workDir,           // Where workspaces are extracted
    transport,         // How files are transferred
    sandbox,           // Security constraints
    policy,            // Limits and rules
    hooks: {
      onInvite,        // Accept/decline delegations
      onTaskStart,     // Configure your AI's workspace
      onTaskComplete,  // Cleanup after task
      onError,         // Handle failures
    },
  };
}
```

### `openclaw-executor.ts` - AI Integration

```typescript
// Implement AgentExecutor interface
export class OpenClawExecutor implements AgentExecutor {
  setWorkingDirectory(dir: string, context?: AwcpContext): void {
    // Configure your AI to work in this directory
  }

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    // Send task to your AI and stream results
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development mode
npm run dev
```

## Troubleshooting

### OpenClaw not found
```bash
npm install -g openclaw@latest
```

### Gateway fails to start
Check if the port is in use:
```bash
lsof -i :18789
```

### No API key error
Ensure one of the supported API keys is set:
```bash
echo $DEEPSEEK_API_KEY
```

## License

MIT
