# Synergy Executor

AWCP Executor powered by [Synergy](https://github.com/EricSanchezok/holos-synergy) AI coding agent.

This example demonstrates how to create a production-ready AWCP Executor that uses a real AI coding agent (Synergy) to execute tasks on delegated workspaces.

## Features

- **A2A Protocol** - Agent discovery via Agent Card
- **AWCP Protocol** - Workspace delegation with Archive transport (default)
- **Synergy Integration** - Full AI coding capabilities

## Prerequisites

1. **Node.js >= 22**

2. **Synergy CLI**
   ```bash
   npm install -g @ericsanchezok/synergy@latest
   ```

3. **AI API Key** (one of):
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   # or
   export OPENAI_API_KEY=sk-...
   ```

## Quick Start

```bash
# One-click startup (starts both Synergy and Executor)
./run.sh
```

This will:
1. Start Synergy server on port 4096
2. Start Executor Agent on port 4001
3. Display endpoints for A2A and AWCP

## Manual Start

```bash
# Terminal 1: Start Synergy
synergy serve --port 4096

# Terminal 2: Start Executor
npm install
SCENARIO_DIR=$(pwd) npx tsx src/agent.ts
```

## Endpoints

| Endpoint | URL | Description |
|----------|-----|-------------|
| Agent Card | `http://localhost:10200/.well-known/agent-card.json` | A2A discovery |
| A2A | `http://localhost:10200/a2a` | JSON-RPC endpoint |
| AWCP | `http://localhost:10200/awcp` | Workspace delegation |
| Health | `http://localhost:10200/health` | Health check |

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `10200` | Executor agent port |
| `AGENT_URL` | `http://localhost:${PORT}` | Public URL for Agent Card (set this for public deployment) |
| `SYNERGY_URL` | `http://localhost:4096` | Synergy server URL |
| `AWCP_TRANSPORT` | `archive` | Transport type (`archive` or `sshfs`) |
| `SCENARIO_DIR` | `./` | Directory for workdir/temp/logs |

## Usage with AWCP Delegator

```typescript
import { DelegatorService } from '@awcp/sdk';
import { ArchiveTransport } from '@awcp/transport-archive';

const delegator = new DelegatorService({
  exportsDir: './exports',
  transport: new ArchiveTransport({ delegator: { tempDir: './temp' } }),
});

const result = await delegator.delegate({
  executorUrl: 'http://localhost:4001/awcp',
  workspacePath: './my-project',
  task: {
    description: 'Add unit tests',
    prompt: 'Add comprehensive unit tests for the UserService class',
  },
});

console.log(result.summary);
```

## Directory Structure

```
synergy-executor/
├── src/
│   ├── agent.ts           # Main server (A2A + AWCP)
│   ├── agent-card.ts      # A2A Agent Card definition
│   ├── awcp-config.ts     # AWCP configuration
│   ├── synergy-executor.ts # Synergy integration
│   └── config.ts          # Configuration loader
├── workdir/               # Mounted/extracted workspaces
├── temp/                  # Temporary files (archives)
├── logs/                  # Runtime logs
├── run.sh                 # One-click startup
└── cleanup.sh             # Clean runtime directories
```

## How It Works

1. **Delegator** sends AWCP INVITE to `/awcp`
2. **Executor** accepts and returns mount point
3. **Delegator** sends START with archive URLs
4. **Executor** downloads and extracts workspace to `workdir/`
5. **Executor** creates Synergy session pointing to workspace
6. **Synergy** executes the task (reads/writes files)
7. **Executor** re-archives workspace and uploads changes
8. **Executor** sends DONE with summary to callback URL
