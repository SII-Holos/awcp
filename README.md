# AWCP - Agent Workspace Collaboration Protocol

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

AWCP enables secure workspace delegation between AI agents. A Delegator agent can share a local directory with an Executor agent, who can then read/write files using their native tools - as if the workspace were local.

## Key Features

- **Transparent Workspace Access**: Executor uses native tools (read, write, shell) on delegated workspace
- **Secure by Design**: Lease-based sessions, temporary SSH keys, policy-controlled mount points
- **MCP Integration**: Use AWCP directly from Claude or other MCP-compatible AI agents
- **Built on A2A**: Uses [Agent2Agent Protocol](https://github.com/a2aproject/A2A) for agent communication
- **SSHFS Data Plane**: Reliable remote filesystem via SSH

## Packages

| Package | Description |
|---------|-------------|
| `@awcp/core` | Protocol types, state machine, errors |
| `@awcp/sdk` | Delegator and Executor service implementations |
| `@awcp/transport-sshfs` | SSHFS transport (credential manager, mount client) |
| `@awcp/mcp` | MCP tools for AI agents (delegate, delegate_output, delegate_cancel) |

## Quick Start

### Option 1: MCP Tools (for AI Agents)

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "awcp": {
      "command": "npx",
      "args": ["@awcp/mcp", "--daemon-url", "http://localhost:3100"]
    }
  }
}
```

Then Claude can delegate tasks:

```
Use the delegate tool to ask another agent to review the code in ./src
```

### Option 2: Programmatic SDK

```bash
npm install @awcp/sdk
```

**Delegator side:**

```typescript
import { startDelegatorDaemon, DelegatorDaemonClient } from '@awcp/sdk';

// Start daemon
const daemon = await startDelegatorDaemon({
  port: 3100,
  delegator: {
    export: { baseDir: '/tmp/awcp/exports' },
    ssh: { host: 'localhost', user: 'me', port: 22 },
  },
});

// Create delegation
const client = new DelegatorDaemonClient('http://localhost:3100');
const { delegationId } = await client.delegate({
  executorUrl: 'http://executor-agent:4001/awcp',
  localDir: '/path/to/workspace',
  task: {
    description: 'Review and fix bugs',
    prompt: 'Please review the code and fix any issues...',
  },
});

// Wait for result
const result = await client.waitForCompletion(delegationId);
console.log(result.result?.summary);
```

**Executor side:**

```typescript
import express from 'express';
import { executorHandler } from '@awcp/sdk/server/express';

const app = express();

app.use('/awcp', executorHandler({
  executor: myAgentExecutor,  // Your A2A AgentExecutor
  config: {
    mount: { root: '/tmp/awcp/mounts' },
  },
}));

app.listen(4001);
```

## Protocol Flow

```
Delegator                              Executor
    |                                      |
    |  1. INVITE (task, constraints)       |
    |------------------------------------->|
    |                                      | 2. Policy check
    |  3. ACCEPT (mount_point)             |
    |<-------------------------------------|
    |                                      |
    | 4. Create export view & SSH key      |
    |  5. START (credential, endpoint)     |
    |------------------------------------->|
    |                                      | 6. Mount via SSHFS
    |                                      | 7. Execute task
    |  8. DONE (summary)                   |
    |<-------------------------------------|
    |                                      |
    | 9. Revoke SSH key & cleanup          |
```

## Running Experiments

```bash
# Clone and install
git clone https://github.com/anthropics/awcp.git
cd awcp && npm install && npm run build

# Run basic delegation test
cd experiments/scenarios/01-local-basic && ./run.sh

# Run admission control test  
cd experiments/scenarios/02-admission-test && ./run.sh

# Run MCP integration test
cd experiments/scenarios/03-mcp-integration && ./run.sh
```

## Requirements

- Node.js 18+
- SSHFS:
  - macOS: `brew install macfuse && brew install sshfs`
  - Linux: `apt install sshfs`

## Setup

AWCP uses SSH certificates for secure, password-free authentication. Run the setup command to configure:

```bash
# Check current status and see manual instructions
npx @awcp/transport-sshfs setup

# Or auto-configure (requires sudo for sshd config)
npx @awcp/transport-sshfs setup --auto
```

**What the setup does:**

1. **Generates a CA key** at `~/.awcp/ca` (if not present)
2. **Configures sshd** to trust the CA by adding `TrustedUserCAKeys` to `/etc/ssh/sshd_config`

Once configured, AWCP automatically:
- Generates a temporary SSH key pair for each delegation
- Signs it with the CA (with short TTL)
- Revokes credentials immediately after task completion

**Manual setup** (if you prefer not to use `--auto`):

```bash
# 1. Generate CA key (AWCP auto-generates this on first use)
ssh-keygen -t ed25519 -f ~/.awcp/ca -N "" -C "awcp-ca"

# 2. Add to sshd config (requires sudo)
echo "TrustedUserCAKeys $HOME/.awcp/ca.pub" | sudo tee -a /etc/ssh/sshd_config

# 3. Restart sshd
# macOS:
sudo launchctl kickstart -k system/com.openssh.sshd
# Linux:
sudo systemctl restart sshd
```

## Documentation

- [Protocol Specification](docs/v1.md) - Full protocol design
- [Development Guide](AGENTS.md) - For contributors

## License

Apache 2.0 - See [LICENSE](LICENSE)

## Related

- [A2A Protocol](https://github.com/a2aproject/A2A) - Agent-to-agent communication
- [MCP](https://github.com/modelcontextprotocol/specification) - Model Context Protocol
