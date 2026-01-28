# AWCP Experiment Environment

This directory contains a complete experiment environment for testing the AWCP (Agent Workspace Collaboration Protocol).

## Overview

```
┌─────────────────────────┐         ┌─────────────────────────┐
│     Host Server         │   A2A   │     Remote Server       │
│     (port 4000)         │ ◄─────► │     (port 4001)         │
│                         │  HTTP   │                         │
│  • HostDaemon           │         │  • RemoteDaemon         │
│  • CredentialManager    │         │  • SshfsMountClient     │
│  • Export View          │         │  • Mock Agent           │
└───────────┬─────────────┘         └───────────┬─────────────┘
            │                                   │
            │         SSHFS Mount               │
            │◄──────────────────────────────────┘
            │
            ▼
    scenarios/basic/workspace/     →    scenarios/basic/mount/
```

## Prerequisites

### 1. SSH Service (on Host machine)

**macOS:**
```bash
# Enable Remote Login in System Settings
# System Settings → General → Sharing → Remote Login → ON
```

**Linux:**
```bash
sudo apt install openssh-server
sudo systemctl enable ssh
sudo systemctl start ssh
```

### 2. SSHFS (on Remote machine)

**macOS:**
```bash
brew install macfuse
brew install sshfs
```

**Linux:**
```bash
sudo apt install sshfs
```

### 3. Node.js Dependencies

```bash
cd experiment
npm install
```

## Quick Start (Local Mode)

In local mode, both Host and Remote run on the same machine, connecting via localhost.

### Option 1: Use the CLI (Recommended)

```bash
# Terminal 1: Start Remote server
npm run remote

# Terminal 2: Run delegation via CLI
npm run delegate
```

### Option 2: Use start script

```bash
# Start both servers (in one terminal with concurrently)
./scripts/start-local.sh

# In another terminal, trigger delegation
npm run delegate
```

## Directory Structure

```
experiment/
├── src/
│   ├── a2a/                 # A2A protocol implementation
│   │   ├── server.ts        # HTTP server for A2A messages
│   │   ├── client.ts        # HTTP client for sending messages
│   │   └── types.ts         # A2A message types
│   │
│   ├── host/
│   │   └── index.ts         # Host server entry point
│   │
│   ├── remote/
│   │   ├── index.ts         # Remote server entry point
│   │   └── mock-agent.ts    # Simulated agent (file operations)
│   │
│   ├── config.ts            # Configuration loader
│   └── cli.ts               # CLI tool
│
├── configs/
│   ├── local.env            # Local mode config
│   ├── two-machines-host.env
│   └── two-machines-remote.env
│
├── scenarios/
│   ├── basic/               # Simple test scenario
│   │   ├── workspace/       # Host's data
│   │   └── mount/           # Remote's mount point
│   │
│   └── multi-file/          # More complex scenario
│       ├── workspace/
│       └── mount/
│
└── scripts/
    ├── start-local.sh
    ├── start-host.sh
    ├── start-remote.sh
    └── trigger-delegation.sh
```

## Configuration

### Local Mode (`configs/local.env`)

```bash
MODE=local
HOST_PORT=4000
REMOTE_PORT=4001
SSH_HOST=localhost
SCENARIO=basic
```

### Two Machines Mode

On Host machine, use `configs/two-machines-host.env`:
```bash
MODE=host-only
HOST_PORT=4000
SSH_HOST=<your-ip>
```

On Remote machine, use `configs/two-machines-remote.env`:
```bash
MODE=remote-only
REMOTE_PORT=4001
SSH_HOST=<host-ip>
```

## CLI Commands

```bash
# Create a delegation
npm run delegate

# With options
npm run delegate -- --task="Add headers" --ttl=1800 --access=rw

# Check status (requires running Host server)
npm run status -- <delegation-id>

# Clean up mount points
npm run clean
```

## Mock Agent Types

The mock agent supports different operation modes:

| Type | Description |
|------|-------------|
| `add-header` | Adds a header comment to all source files |
| `create-summary` | Creates a summary of the workspace |
| `uppercase-comments` | Converts comments to uppercase |

Configure in `configs/local.env`:
```bash
MOCK_AGENT_TYPE=add-header
```

## Expected Output

When you run a successful delegation, you should see:

```
[Host] → Sending INVITE to http://localhost:4001
[Remote] ← Received INVITE from http://localhost:4000
[Remote] → Sending ACCEPT to http://localhost:4000
[Host] ← Received ACCEPT
[Host] → Sending START to http://localhost:4001
[Remote] 🔗 Mounting workspace...
[Remote] ✓ Mount successful
[Mock Agent] Processing files...
[Mock Agent] ✓ Modified: hello.ts
[Mock Agent] ✓ Modified: utils.ts
[Remote] 🔓 Unmounting...
[Remote] → Sending DONE to http://localhost:4000
[Host] 🎉 Delegation completed!
```

After completion, check your workspace:
```bash
cat scenarios/basic/workspace/hello.ts
# Should now have a header comment added by the agent
```

## Troubleshooting

### SSHFS mount fails

1. Check SSH service is running:
   ```bash
   ssh localhost
   ```

2. Check SSHFS is installed:
   ```bash
   sshfs --version
   ```

3. On macOS, ensure macFUSE is allowed in Security settings

### Permission denied

Make sure SSH keys are set up for localhost:
```bash
ssh-keygen -t ed25519  # if you don't have a key
ssh-copy-id localhost  # copy to authorized_keys
```

### Port already in use

Change ports in config file or use environment variables:
```bash
HOST_PORT=4010 REMOTE_PORT=4011 npm run start-local
```

## Development

To modify the experiment:

1. Edit source files in `src/`
2. Add new scenarios in `scenarios/`
3. Create new configs in `configs/`

The code uses `tsx` for direct TypeScript execution, no build step needed.
