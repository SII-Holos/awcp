# AWCP Development Guidelines

This document provides guidelines for AI agents and developers working on the AWCP codebase.

## Project Structure

```
packages/
├── core/           # @awcp/core - Protocol types, state machine, errors
├── sdk/            # @awcp/sdk - Host and Remote daemon implementations  
└── transport-sshfs/# @awcp/transport-sshfs - SSHFS data plane

examples/
└── basic-delegation/  # Basic usage example

docs/               # Protocol specification and documentation
docs/               # Documentation
```

## Development Commands

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test

# Type check
npm run typecheck
```

## Code Style

- Use TypeScript strict mode
- Prefer explicit types over inference for public APIs
- Use `type` for type aliases, `interface` for object shapes that may be extended
- Error classes extend `AwcpError` from `@awcp/core`
- Use async/await, not callbacks
- Keep functions small and focused

## Package Dependencies

```
@awcp/core          (no internal deps)
    ↑
@awcp/sdk           (depends on core)
    ↑
@awcp/transport-*   (depends on core, optionally sdk)
```

## Naming Conventions

- Message types: `InviteMessage`, `AcceptMessage`, `StartMessage`, etc.
- Error codes: `SCREAMING_SNAKE_CASE` (e.g., `WORKSPACE_TOO_LARGE`)
- State names: `lowercase` (e.g., `created`, `invited`, `running`)
- Config interfaces: `*Config` suffix (e.g., `HostDaemonConfig`)
- Event interfaces: `*Events` suffix (e.g., `HostDaemonEvents`)

## Protocol Implementation Notes

1. **State Machine**: All state transitions must go through `DelegationStateMachine`
2. **Messages**: Use `PROTOCOL_VERSION` constant from core
3. **Errors**: Use typed errors from `@awcp/core/errors`
4. **Mount Points**: Remote always decides mount location (security requirement)
5. **Credentials**: Never sent in INVITE, only in START after ACCEPT

## Testing

- Unit tests: Use Vitest
- Integration tests: Use the demo example pattern
- Always mock filesystem and network operations in tests

## Adding New Transport

1. Create new package: `packages/transport-{name}/`
2. Implement host-side credential/export management
3. Implement remote-side mount/unmount client
4. Export from package index
5. Add example usage
