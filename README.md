# AWCP - Agent Workspace Collaboration Protocol

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**AWCP enables AI agents to collaborate on real codebases.** A Delegator agent can share a local directory with an Executor agent, who can then read, write, and modify files using their native tools—as if the workspace were on their own machine.

## Why AWCP?

Modern AI agents are powerful, but they're isolated. When Claude needs help from a specialized agent (code review, testing, documentation), there's no standard way to share workspace access. AWCP solves this:

- **Real file access**: Executor agents work with actual files, not copy-pasted snippets
- **Lease-based sessions**: Time-limited delegations with automatic cleanup
- **Drop-in integration**: Works with Claude Desktop via MCP, or any A2A-compatible agent
- **Flexible transports**: Archive (HTTP+ZIP) for remote agents, SSHFS for low-latency local setups

## Quick Start

### For Claude Desktop Users

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "awcp": {
      "command": "npx",
      "args": ["@awcp/mcp", "--peers", "http://localhost:10200"]
    }
  }
}
```

Then ask Claude:

> "Use the delegate tool to ask another agent to review the code in ./src"

See [@awcp/mcp README](packages/mcp/README.md) for all configuration options.

### For Developers

Install the SDK to build your own Delegator or Executor:

```bash
npm install @awcp/sdk @awcp/transport-archive
```

**Delegator side** (the agent sharing its workspace):

```typescript
import { startDelegatorDaemon, DelegatorDaemonClient } from '@awcp/sdk';
import { ArchiveTransport } from '@awcp/transport-archive';

// Start daemon
const daemon = await startDelegatorDaemon({
  port: 3100,
  delegator: {
    environment: { baseDir: '/tmp/awcp/environments' },
    transport: new ArchiveTransport({ delegator: { tempDir: '/tmp/awcp/temp' } }),
  },
});

// Create delegation
const client = new DelegatorDaemonClient('http://localhost:3100');
const { delegationId } = await client.delegate({
  executorUrl: 'http://executor-agent:10200/awcp',
  environment: {
    resources: [{ name: 'workspace', type: 'fs', source: '/path/to/project', mode: 'rw' }],
  },
  task: {
    description: 'Review and fix bugs',
    prompt: 'Please review the code and fix any issues...',
  },
});

// Wait for result
const result = await client.waitForCompletion(delegationId);
console.log(result.result?.summary);
```

**Executor side** (the agent receiving and working on the workspace):

```typescript
import express from 'express';
import { executorHandler } from '@awcp/sdk/server/express';
import { ArchiveTransport } from '@awcp/transport-archive';

const app = express();

app.use('/awcp', executorHandler({
  executor: myAgentExecutor,  // Your A2A AgentExecutor implementation
  config: {
    workDir: '/tmp/awcp/workdir',
    transport: new ArchiveTransport({ executor: {} }),
  },
}));

app.listen(10200);
```

## How It Works

AWCP uses a lease-based delegation model with clear separation between control plane (HTTP) and data plane (transport-specific):

```
Delegator                              Executor
    │                                      │
    │  1. INVITE (task, environment)       │
    │─────────────────────────────────────>│
    │                                      │ 2. Policy check
    │  3. ACCEPT (workDir, constraints)    │
    │<─────────────────────────────────────│
    │                                      │
    │ 4. Build environment & credentials   │
    │  5. START (lease, workDirInfo)       │
    │─────────────────────────────────────>│
    │                                      │ 6. Setup workspace
    │  7. { ok: true }                     │
    │<─────────────────────────────────────│
    │                                      │
    │  8. GET /tasks/:id/events (SSE)      │ 9. Execute task
    │─────────────────────────────────────>│
    │  ◄── SSE: { type: "status" } ────────│
    │  ◄── SSE: { type: "done" } ──────────│ 10. Teardown
    │                                      │
    │ 11. Apply result & cleanup           │
```

Key design principles:
- **Executor controls its workspace**: Delegator cannot specify where files are mounted
- **Credentials are short-lived**: SSH certificates and leases have configurable TTL
- **Async execution**: Tasks run asynchronously with real-time status via SSE

## Packages

| Package | Description |
|---------|-------------|
| [`@awcp/core`](packages/core) | Protocol types, state machine, errors |
| [`@awcp/sdk`](packages/sdk) | Delegator and Executor service implementations |
| [`@awcp/transport-archive`](packages/transport-archive) | Archive transport (HTTP + ZIP) |
| [`@awcp/transport-sshfs`](packages/transport-sshfs) | SSHFS transport (SSH + mount) |
| [`@awcp/mcp`](packages/mcp) | MCP tools for AI agents |

## Transports

AWCP supports pluggable transports for the data plane:

| Transport | Best For | How It Works |
|-----------|----------|--------------|
| **Archive** (default) | Remote executors, cloud environments | Workspace packaged as ZIP, transferred via HTTP |
| **SSHFS** | Local executors, low latency needs | Real-time filesystem mount via SSH |

### Archive Transport

Zero setup required. Works anywhere with HTTP connectivity.

```bash
awcp-mcp --transport archive --peers http://remote-executor:10200
```

### SSHFS Transport

Requires SSH infrastructure but provides real-time file sync.

```bash
# One-time setup
npx @awcp/transport-sshfs setup --auto

# Use with MCP
awcp-mcp --transport sshfs --ssh-ca-key ~/.awcp/ca --peers http://localhost:10200
```

## Running the Examples

```bash
# Clone and build
git clone https://github.com/anthropics/awcp.git
cd awcp && npm install && npm run build

# Basic delegation test
cd experiments/scenarios/01-local-basic && ./run.sh

# Admission control (workspace size limits)
cd experiments/scenarios/02-admission-test && ./run.sh

# MCP integration
cd experiments/scenarios/03-mcp-integration && ./run.sh

# Archive transport
cd experiments/scenarios/04-archive-transport && ./run.sh
```

See [examples/synergy-executor](examples/synergy-executor) for a complete Executor implementation using the Synergy AI agent.

## Requirements

- Node.js 18+
- For SSHFS transport:
  - macOS: `brew install macfuse sshfs`
  - Linux: `apt install sshfs`

## Documentation

- **[Protocol Specification](docs/v1.md)** — Complete protocol design and message formats
- **[MCP Tools Reference](packages/mcp/README.md)** — Configuration options for Claude Desktop
- **[Development Guide](AGENTS.md)** — Architecture and contribution guidelines

## Contributing

We welcome contributions! Please see [AGENTS.md](AGENTS.md) for development setup and guidelines.

Areas where we'd love help:
- Additional transport implementations (WebDAV, S3, etc.)
- Language bindings (Python, Go, Rust)
- Integration with other AI agent frameworks
- Documentation and examples

## License

Apache 2.0 — See [LICENSE](LICENSE)

## Related Projects

- [A2A Protocol](https://github.com/google/A2A) — Agent-to-agent communication standard
- [MCP](https://modelcontextprotocol.io/) — Model Context Protocol for AI tool integration
