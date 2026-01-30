# AWCP Development Guidelines

Guidelines for AI agents and developers working on the AWCP codebase.

## Project Structure

```
packages/
├── core/              # @awcp/core - Protocol types, state machine, errors
│   └── test/          # Unit tests (vitest)
├── sdk/               # @awcp/sdk - Delegator and Executor implementations
│   └── test/          # Unit tests (vitest)
├── transport-sshfs/   # @awcp/transport-sshfs - SSHFS transport adapter
│   └── test/          # Unit tests (vitest)
└── transport-archive/ # @awcp/transport-archive - HTTP archive transport
    └── test/          # Unit tests (vitest)

experiments/
├── shared/
│   └── executor-agent/   # Shared A2A executor agent
└── scenarios/
    ├── 01-local-basic/      # Basic delegation test
    ├── 02-admission-test/   # Admission control test
    └── 03-mcp-integration/  # MCP tools integration test
```

## Development Commands

```bash
npm install           # Install dependencies
npm run build         # Build all packages
npm test              # Run all tests (unit + integration)
npm run typecheck     # Type check

# Run specific package tests
npm test -w @awcp/core
npm test -w @awcp/sdk

# Run integration test scenarios
cd experiments/scenarios/01-local-basic && ./run.sh
cd experiments/scenarios/02-admission-test && ./run.sh
```

## Package Dependencies

```
@awcp/core              (no internal deps)
    ↑
@awcp/transport-sshfs   (depends on core)
@awcp/transport-archive (depends on core)

@awcp/sdk               (depends on core, uses transport via injection)
```

## Key Components

### Delegator Side (packages/sdk/src/delegator/)

| File | Purpose |
|------|---------|
| `service.ts` | Main service - manages delegation lifecycle |
| `admission.ts` | Workspace size/file count validation |
| `config.ts` | Configuration with defaults |
| `export-manager.ts` | Creates export directories for delegation |
| `executor-client.ts` | HTTP client to send messages to Executor |
| `bin/daemon.ts` | Standalone HTTP daemon |
| `bin/client.ts` | Client SDK for daemon API |

### Executor Side (packages/sdk/src/executor/)

| File | Purpose |
|------|---------|
| `service.ts` | Main service - handles INVITE/START messages |
| `workspace-manager.ts` | Workspace allocation and cleanup |
| `config.ts` | Configuration with defaults |
| `delegator-client.ts` | HTTP client to send DONE/ERROR back |

### Transport: SSHFS (packages/transport-sshfs/)

| File | Purpose |
|------|---------|
| `sshfs-transport.ts` | TransportAdapter implementation |
| `delegator/credential-manager.ts` | SSH key generation/revocation |
| `executor/sshfs-client.ts` | SSHFS mount/unmount operations |

### Transport: Archive (packages/transport-archive/)

| File | Purpose |
|------|---------|
| `archive-transport.ts` | TransportAdapter implementation |
| `delegator/archive-creator.ts` | Creates ZIP from export directory |
| `delegator/archive-server.ts` | HTTP server for download/upload |
| `executor/archive-client.ts` | HTTP client for transfers |
| `executor/archive-extractor.ts` | Extracts ZIP to work directory |

## Protocol Flow

```
Delegator                              Executor
    │                                      │
    │ ─── INVITE (sync) ─────────────────► │  handleInvite()
    │ ◄── ACCEPT ──────────────────────────│
    │                                      │
    │ ─── START (async, returns {ok:true})►│  handleStart()
    │                                      │    └─► mount → execute → unmount
    │ ◄── DONE/ERROR (callback) ──────────│
```

**Key Points:**
- INVITE/ACCEPT are synchronous HTTP request/response
- START returns immediately with `{ok:true}`, task runs async
- DONE/ERROR sent to Delegator's callback URL (X-AWCP-Callback-URL header)
- Cleanup (unmount, revoke keys) happens before sending DONE

## State Machine

Valid states: `created → invited → accepted → started → running → completed`

Terminal states: `completed`, `error`, `cancelled`, `expired`

All transitions must go through `DelegationStateMachine` from `@awcp/core`.

## Error Handling

All errors extend `AwcpError` from `@awcp/core`:

```typescript
// Throwing
throw new WorkspaceTooLargeError(stats, hint, delegationId);

// HTTP response includes hint
res.status(400).json({
  error: error.message,
  code: error.code,
  hint: error.hint,
});
```

Available errors: `DeclinedError`, `DependencyMissingError`, `WorkspaceTooLargeError`, 
`MountPointDeniedError`, `MountFailedError`, `TaskFailedError`, `LeaseExpiredError`, `AuthFailedError`

## Admission Control

Delegator validates workspace before sending INVITE:

```typescript
// In delegator config
admission: {
  maxTotalBytes: 100 * 1024 * 1024,  // 100MB
  maxFileCount: 10000,
  maxSingleFileBytes: 50 * 1024 * 1024,  // 50MB
}
```

Implementation skips `node_modules/` and `.git/` directories.

## SSH Key Management

- Keys stored in `~/.awcp/keys/` (not `/tmp`)
- Public key added to `~/.ssh/authorized_keys` with marker `awcp-temp-key-{delegationId}`
- Keys revoked immediately after DONE/ERROR
- `cleanupStaleKeys()` removes orphaned keys on startup

## SSHFS Notes

- Uses `noappledouble` option to prevent macOS `._*` files
- Mount detection via device number comparison (not process monitoring)
- Timeout cleanup includes zombie mount removal

## Testing

### Unit Tests (Vitest)

```bash
npm test  # Runs all package tests
```

Test locations:
- `packages/core/test/` - State machine, message types
- `packages/sdk/test/` - Admission, config, services
- `packages/transport-sshfs/test/` - Credential manager, SSHFS client
- `packages/transport-archive/test/` - Archive creator, server, transport

### Integration Tests

```bash
cd experiments/scenarios/01-local-basic && ./run.sh   # Full flow
cd experiments/scenarios/02-admission-test && ./run.sh # Admission rejection
cd experiments/scenarios/03-mcp-integration && ./run.sh # MCP tools
```

## Code Style

- TypeScript strict mode
- Explicit types for public APIs
- `interface` for extensible shapes, `type` for aliases
- async/await (no callbacks)
- Errors extend `AwcpError`

## Naming Conventions

- Messages: `InviteMessage`, `AcceptMessage`, `StartMessage`, `DoneMessage`, `ErrorMessage`
- Error codes: `SCREAMING_SNAKE_CASE` (e.g., `WORKSPACE_TOO_LARGE`)
- States: `lowercase` (e.g., `created`, `invited`, `running`)
- Config: `*Config` suffix
- Hooks: `on*` prefix (e.g., `onInvite`, `onTaskComplete`)

## Adding New Transport

1. Create `packages/transport-{name}/`
2. Implement `TransportAdapter` interface from `@awcp/core`
3. Delegator side: `prepare()` and `cleanup()` methods
4. Executor side: `checkDependency()`, `setup()`, and `teardown()` methods
5. Add tests in `test/`
6. Add integration scenario in `experiments/scenarios/`
