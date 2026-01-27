# AWCP - Agent Workspace Collaboration Protocol

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

AWCP is an open protocol for multi-agent workspace collaboration. It enables a local agent (Host) to securely delegate workspace access to remote agents (Remote) for collaborative task completion.

## Key Features

- **Transparent Workspace Access**: Remote agents can use their native tools (read, write, CLI) on delegated workspaces
- **Secure by Design**: Lease-based sessions, credential isolation, and policy-controlled mount points
- **Built on A2A**: Uses [Agent2Agent Protocol](https://github.com/a2aproject/A2A) for control plane communication
- **SSHFS Data Plane**: Reliable, well-understood remote filesystem transport

## Quick Start

```bash
# Install
npm install @awcp/sdk @awcp/transport-sshfs

# Or with specific packages
npm install @awcp/core  # Types and state machine only
```

## Basic Usage

### Host (Delegator)

```typescript
import { HostDaemon } from '@awcp/sdk';
import { CredentialManager } from '@awcp/transport-sshfs';

const credentialManager = new CredentialManager();
const hostDaemon = new HostDaemon({
  sendMessage: async (peerUrl, msg) => { /* A2A send */ },
  generateCredential: (id, ttl) => credentialManager.generateCredential(id, ttl),
  revokeCredential: (id) => credentialManager.revokeCredential(id),
});

// Create delegation
const delegationId = await hostDaemon.createDelegation({
  peerUrl: 'http://remote-agent/a2a',
  localDir: '/path/to/workspace',
  task: {
    description: 'Review and fix code',
    prompt: 'Please review the code and fix any bugs...',
  },
  ttlSeconds: 3600,
  accessMode: 'rw',
});

// Wait for completion
const result = await hostDaemon.waitForResult(delegationId);
console.log(result.result?.summary);
```

### Remote (Collaborator)

```typescript
import { RemoteDaemon } from '@awcp/sdk';
import { SshfsMountClient } from '@awcp/transport-sshfs';

const sshfsClient = new SshfsMountClient();
const remoteDaemon = new RemoteDaemon({
  sendMessage: async (peerUrl, msg) => { /* A2A send */ },
  mount: (params) => sshfsClient.mount(params),
  unmount: (mountPoint) => sshfsClient.unmount(mountPoint),
  executeTask: async ({ mountPoint, task }) => {
    // Your agent logic here
    return { summary: 'Task completed!' };
  },
});
```

## Protocol Flow

```
Host                              Remote
  |                                  |
  |  1. INVITE (task, constraints)   |
  |--------------------------------->|
  |                                  | 2. Policy Check
  |  3. ACCEPT (mount_point)         |
  |<---------------------------------|
  |                                  |
  | 4. Create Export View            |
  | 5. START (credential, endpoint)  |
  |--------------------------------->|
  |                                  | 6. Mount & Execute
  |  7. DONE (summary)               |
  |<---------------------------------|
  |                                  |
  | 8. Cleanup                       |
```

## Packages

| Package | Description |
|---------|-------------|
| `@awcp/core` | Protocol types, state machine, error definitions |
| `@awcp/sdk` | Host and Remote daemon implementations |
| `@awcp/transport-sshfs` | SSHFS-based data plane transport |

## Documentation

- [Protocol Specification](docs/v1.md) - Detailed protocol design
- [Examples](examples/) - Usage examples
- [Development Guide](AGENTS.md) - Contributing guidelines

## Requirements

- Node.js 18+
- For SSHFS transport:
  - macOS: `brew install macfuse && brew install sshfs`
  - Linux: `apt install sshfs`

## License

Apache 2.0 - See [LICENSE](LICENSE) for details.

## Related Projects

- [A2A Protocol](https://github.com/a2aproject/A2A) - Agent2Agent communication protocol
- [MCP](https://github.com/anthropics/model-context-protocol) - Model Context Protocol
