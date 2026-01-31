# AWCP Development Guidelines

## Project Structure

```
packages/
├── core/              # Protocol types, state machine, errors
├── sdk/               # Delegator and Executor implementations
├── transport-sshfs/   # SSHFS transport (SSH key + mount)
└── transport-archive/ # Archive transport (HTTP + ZIP)

experiments/
├── shared/executor-agent/  # Shared test executor
└── scenarios/              # Integration tests (01-04)
```

## Commands

```bash
npm install && npm run build && npm test   # Full build + test
npm run typecheck                          # Type check only

# Integration scenarios
cd experiments/scenarios/01-local-basic && ./run.sh
```

## Package Dependencies

```
@awcp/core  ←  @awcp/transport-{sshfs,archive}
                        ↓
              @awcp/sdk (transport injected)
```

## Protocol Flow

```
Delegator                              Executor
    │ ─── INVITE (sync) ─────────────► │
    │ ◄── ACCEPT ──────────────────────│
    │ ─── START ──────────────────────►│  → setup delegation
    │ ◄── {ok:true} ───────────────────│
    │ ─── GET /tasks/:id/events (SSE) ►│  → execute task
    │ ◄── event: status ───────────────│
    │ ◄── event: done {resultBase64} ──│  → teardown
```

- INVITE/ACCEPT: synchronous request/response
- START: waits for delegation setup, returns `{ok:true}`, task runs async
- Task events: Delegator subscribes via SSE, receives status/done/error events
- Archive transport: result returned as base64 in done event, applied to original workspace

## State Machine

`created → invited → accepted → started → running → completed`

Terminal: `completed`, `error`, `cancelled`, `expired`

## Error Handling

All errors extend `AwcpError` with `code` and `hint` fields:

```typescript
throw new WorkspaceTooLargeError(stats, hint, delegationId);
// Available: DeclinedError, DependencyMissingError, WorkspaceTooLargeError,
//   WorkDirDeniedError, SetupFailedError, TaskFailedError, LeaseExpiredError, AuthFailedError
```

## Admission Control

```typescript
admission: { maxTotalBytes: 100MB, maxFileCount: 10000, maxSingleFileBytes: 50MB }
```

Skips `node_modules/` and `.git/`.

## Scenario Directories

| Directory | Purpose |
|-----------|---------|
| `workspace/` | Source project (input) |
| `exports/` | Export copies for delegation |
| `workdir/` | Executor working dir (mount or extract target) |
| `temp/` | ZIP archives (Archive transport) |
| `logs/` | Runtime logs |

## Code Style

- TypeScript strict, async/await, errors extend `AwcpError`
- Messages: `{Invite,Accept,Start,Done,Error}Message`
- Error codes: `SCREAMING_SNAKE_CASE`, States: `lowercase`
- Config types: `*Config` suffix, Hooks: `on*` prefix

## Adding New Transport

1. Create `packages/transport-{name}/`
2. Implement `TransportAdapter` from `@awcp/core`
3. Delegator: `prepare()`, `cleanup()`
4. Executor: `checkDependency()`, `setup()`, `teardown()`
5. Add tests + integration scenario
