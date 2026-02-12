# AWCP - Agent Workspace Collaboration Protocol

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@awcp/core.svg)](https://www.npmjs.com/package/@awcp/core)

**AWCP enables AI agents to collaborate on real codebases.** A Delegator agent can share a local directory with an Executor agent, who can then read, write, and modify files using their native tools—as if the workspace were on their own machine.

> **Status: v1.0 Beta** — Core protocol is stable and ready for integration testing. See [Roadmap](#roadmap) for planned features.

## Why AWCP?

Modern AI agents are powerful, but they're isolated. When Claude needs help from a specialized agent (code review, testing, documentation), there's no standard way to share workspace access. AWCP solves this:

- **Real file access**: Executor agents work with actual files, not copy-pasted snippets
- **Lease-based sessions**: Time-limited delegations with automatic cleanup
- **Drop-in integration**: Works with Claude Desktop via MCP, or any A2A-compatible agent
- **Flexible transports**: Four pluggable transports — Archive, Storage, SSHFS, and Git

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
import { ArchiveDelegatorTransport } from '@awcp/transport-archive';

// Start daemon
const daemon = await startDelegatorDaemon({
  port: 3100,
  delegator: {
    baseDir: '/tmp/awcp/environments',
    transport: new ArchiveDelegatorTransport({ tempDir: '/tmp/awcp/temp' }),
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
import { A2ATaskExecutor } from '@awcp/sdk';
import { ArchiveExecutorTransport } from '@awcp/transport-archive';

const app = express();

// Wrap your A2A executor with A2ATaskExecutor adapter
const executor = new A2ATaskExecutor(myA2AExecutor);

const awcp = await executorHandler({
  executor,
  config: {
    workDir: '/tmp/awcp/workdir',
    transport: new ArchiveExecutorTransport({}),
  },
});

app.use('/awcp', awcp.router);
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
    │  3. ACCEPT (workDir, constraints)     │
    │<─────────────────────────────────────│
    │                                      │
    │ 4. Build environment & credentials   │
    │  5. START (lease, transportHandle)    │
    │─────────────────────────────────────>│
    │                                      │ 6. Setup workspace
    │  7. { ok: true }                     │
    │<─────────────────────────────────────│
    │                                      │
    │  8. GET /tasks/:id/events (SSE)      │ 9. Execute task
    │─────────────────────────────────────>│
    │  ◄── SSE: { type: "status" } ────────│
    │  ◄── SSE: { type: "done" } ──────────│ 10. Cleanup
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
| [`@awcp/core`](packages/core) | Protocol types, dual state machines, errors |
| [`@awcp/sdk`](packages/sdk) | Delegator and Executor services, listeners, persistence |
| [`@awcp/transport-archive`](packages/transport-archive) | Archive transport (HTTP + ZIP) |
| [`@awcp/transport-sshfs`](packages/transport-sshfs) | SSHFS transport (SSH + FUSE mount) |
| [`@awcp/transport-storage`](packages/transport-storage) | Storage transport (S3/HTTP + pre-signed URLs) |
| [`@awcp/transport-git`](packages/transport-git) | Git transport (version control + branch-based) |
| [`@awcp/mcp`](packages/mcp) | MCP tools (7 tools) for AI agents |

## Transports

AWCP supports pluggable transports for the data plane:

| Transport | Best For | How It Works |
|-----------|----------|--------------|
| **Archive** | Remote executors, simple setup | Workspace as ZIP, inline in messages |
| **Storage** | Large workspaces, cloud environments | Workspace as ZIP, via pre-signed URLs |
| **SSHFS** | Local executors, low latency | Real-time filesystem mount via SSH |
| **Git** | Version-controlled projects | Git repo + branch-based collaboration |

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

### Git Transport

Integrates with existing Git infrastructure (GitHub, GitLab, etc.) for version-controlled collaboration.

```bash
awcp-mcp --transport git --git-remote-url https://github.com/org/repo.git --git-auth-type token --git-auth-token $GITHUB_TOKEN --peers http://localhost:10200
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
- For Git transport: `git` CLI installed

## Documentation

- **[Protocol Specification](docs/v1.md)** — Complete protocol design and message formats
- **[Architecture Diagrams](docs/architecture.md)** — Visual overview of system components and data flow
- **[MCP Tools Reference](packages/mcp/README.md)** — Configuration options for Claude Desktop
- **[Development Guide](AGENTS.md)** — Architecture and contribution guidelines

## Contributing

We welcome contributions! Please see [AGENTS.md](AGENTS.md) for development setup and guidelines.

Areas where we'd love help:
- Additional transport implementations (WebDAV, rsync, etc.)
- Language bindings (Python, Go, Rust)
- Integration with other AI agent frameworks
- Documentation and examples

## Roadmap

### ✅ Implemented (v1.0)
- Core protocol: INVITE → ACCEPT → START → DONE/ERROR flow
- Dual state machines: Delegation (9 states) + Assignment (4 states)
- Four transports: Archive, Storage, SSHFS, Git
- Lease-based sessions with TTL
- Admission control (size/file count limits, sensitive file detection)
- MCP tools (7 tools) for Claude Desktop integration
- SSE-based async task execution with snapshot support
- A2A protocol compatibility via adapter
- Service lifecycle (`initialize`/`shutdown`) and JSON persistence
- Two-phase transport cleanup (`detach`/`release`)
- awcp-skill CLI for Synergy/OpenClaw agents

### 🚧 In Progress
- S3 storage provider for `@awcp/transport-storage`
- Lease expiration timer (auto-cleanup on TTL)
- `delegate_recover` MCP tool (connection recovery)

### 📋 Planned
- File filtering (`include`/`exclude` patterns in resources)
- Progress tracking during task execution
- Sandbox enforcement (cwdOnly, allowNetwork, allowExec)
- Auth metadata handling for Executor authentication
- Python SDK
- Additional transports: WebDAV, rsync

### 💡 Under Consideration
- Multi-executor task orchestration
- Decentralized identity (DID) for trust

See [Protocol Specification](docs/v1.md) §9 for detailed limitations and future directions.

## License

Apache 2.0 — See [LICENSE](LICENSE)

## Related Projects

- [A2A Protocol](https://github.com/google/A2A) — Agent-to-agent communication standard
- [MCP](https://modelcontextprotocol.io/) — Model Context Protocol for AI tool integration
