# AWCP Development Guidelines

## Project Structure

```
packages/
├── core/              # Protocol types, dual state machines, errors (0 deps)
├── sdk/               # Delegator & Executor services, listeners, persistence
├── mcp/               # MCP tools (7 tools) for Claude Desktop / AI agents
├── transport-sshfs/   # SSHFS transport (SSH + FUSE mount)
├── transport-archive/ # Archive transport (HTTP + ZIP), shared archive utils
├── transport-storage/ # Storage transport (S3/HTTP + pre-signed URLs)
└── transport-git/     # Git transport (version control + branch-based)

skill/awcp-skill/      # Bun-based CLI skill for Synergy/OpenClaw agents
```

### Package Dependencies

```
@awcp/core (no dependencies)
    ↑
    ├── @awcp/transport-sshfs
    ├── @awcp/transport-archive ←── @awcp/transport-storage
    │                           ←── @awcp/transport-git
    └── @awcp/sdk
              ↑
              └── @awcp/mcp
```

Types from `@awcp/core`, implementations from `@awcp/sdk`.

## Commands

```bash
npm install && npm run build && npm test   # Full build + test
npm run typecheck                          # Type check only
cd packages/core && npm test               # Single package
```

## Key Architecture Decisions

- **Dual state machines**: `DelegationStateMachine` (9 states, Delegator side) + `AssignmentStateMachine` (4 states: pending/active/completed/error, Executor side)
- **Transport adapter split**: `DelegatorTransportAdapter` and `ExecutorTransportAdapter` — no unified adapter. Methods: `prepare/applySnapshot/detach/release` (Delegator) and `checkDependency/setup/captureSnapshot/detach/release` (Executor)
- **Each transport package** exports `{Name}DelegatorTransport` + `{Name}ExecutorTransport` with separate config types
- **Two-phase cleanup**: `detach` (graceful disconnect) then `release` (final resource cleanup)
- **Service lifecycle**: Both `DelegatorService` and `ExecutorService` require `initialize()` before use and `shutdown()` for cleanup
- **Persistence**: `DelegationManager` / `AssignmentManager` persist state as JSON files to disk
- **START message** uses `transportHandle: TransportHandle` (not `workDir`)

## Conventions

- **Naming**: camelCase locals, SCREAMING_SNAKE constants, PascalCase+Suffix classes, no `I` prefix on interfaces
- **Imports**: `node:` protocol for builtins, `.js` extension for relative imports, `type` keyword for type-only imports
- **Config pattern**: optional user config → `resolve*Config()` applies defaults via `??` → all-required resolved config
- **Errors**: extend `AwcpError`, use `ErrorCodes` const object (15 codes including `SENSITIVE_FILES`)
- **Files**: kebab-case, tests as `*.test.ts`, vitest framework
- **Hooks**: `on*` prefix, all optional, called via optional chaining
- **Logging**: `[AWCP:Component]` prefix

## Adding a New Transport

1. Create `packages/transport-{name}/` with `delegator/` and `executor/` subdirectories
2. Implement `DelegatorTransportAdapter` and `ExecutorTransportAdapter` from `@awcp/core`
3. Export: `{Name}DelegatorTransport`, `{Name}ExecutorTransport`, config types
4. Add tests in `test/`

## Useful Links

- [Protocol Specification](docs/v1.md)
- [Architecture Diagrams](docs/architecture.md)
- [MCP Tools Reference](packages/mcp/README.md)
