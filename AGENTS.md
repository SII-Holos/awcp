# AWCP Development Guidelines

This document provides comprehensive guidelines for AI agents and developers contributing to AWCP. Follow these conventions to maintain consistency across the codebase.

## Project Structure

```
packages/
├── core/              # Protocol types, state machine, errors (0 dependencies)
├── sdk/               # Delegator and Executor service implementations
├── mcp/               # MCP tools for Claude Desktop integration
├── transport-sshfs/   # SSHFS transport (SSH + mount)
└── transport-archive/ # Archive transport (HTTP + ZIP)

experiments/
├── shared/executor-agent/  # Shared test executor
└── scenarios/              # Integration tests (01-05)

examples/
└── synergy-executor/       # Real-world Executor using Synergy AI
```

### Package Dependencies

```
@awcp/core (no dependencies)
    ↑
    ├── @awcp/transport-sshfs
    ├── @awcp/transport-archive
    └── @awcp/sdk
              ↑
              └── @awcp/mcp
```

**Important**: Types should be imported from `@awcp/core`, implementations from `@awcp/sdk`.

## Commands

```bash
npm install && npm run build && npm test   # Full build + test
npm run typecheck                          # Type check only

# Single package
cd packages/core && npm test

# Integration scenarios
cd experiments/scenarios/01-local-basic && ./run.sh
```

## Protocol Flow

```
Delegator                              Executor
    │ ─── INVITE (sync) ─────────────► │
    │ ◄── ACCEPT ──────────────────────│
    │ ─── START ──────────────────────►│  → setup workspace
    │ ◄── {ok:true} ───────────────────│
    │ ─── GET /tasks/:id/events (SSE) ►│  → execute task
    │ ◄── event: status ───────────────│
    │ ◄── event: done {resultBase64} ──│  → teardown
```

## State Machine

```
created → invited → accepted → started → running → completed
                                    ↘        ↘         ↓
                                   error ← cancelled ← expired
```

Terminal states: `completed`, `error`, `cancelled`, `expired`

---

## Naming Conventions

### Variables and Parameters

```typescript
// Local variables: camelCase
const delegationId = randomUUID();

// Constants: SCREAMING_SNAKE_CASE
export const PROTOCOL_VERSION = '1' as const;
export const DEFAULT_ADMISSION = { maxTotalBytes: 100 * 1024 * 1024 } as const;

// Private fields: use `private` keyword, no prefix
private config: ResolvedDelegatorConfig;

// Booleans: is*, has*, allow* prefixes
isTerminalState(state: DelegationState): boolean
```

### Functions and Methods

```typescript
// Verbs: create, get, handle, check, validate, prepare, setup, cleanup
async delegate(params: DelegateParams): Promise<string>
async handleMessage(message: AwcpMessage): Promise<void>

// Factory functions: create*
createDelegation(params): Delegation

// No "Async" suffix - use async keyword
async delegate()     // ✓
async delegateAsync() // ✗
```

### Classes and Interfaces

```typescript
// Classes: PascalCase + descriptive suffix
class DelegatorService       // Service
class AdmissionController    // Controller
class SshfsTransport         // Transport
class AwcpError              // Error

// Interfaces: PascalCase, NO "I" prefix
interface TransportAdapter   // ✓
interface ITransportAdapter  // ✗

// Type suffixes by category:
*Config          // configuration (DelegatorConfig)
Resolved*Config  // after defaults applied (ResolvedDelegatorConfig)
*Hooks           // callbacks (DelegatorHooks)
*Adapter         // abstraction (TransportAdapter)
*Params          // function parameters (DelegateParams)
*Result          // return values (AdmissionResult)
*Context         // execution context (TaskStartContext)
*Event           // events (TaskStatusEvent)
*Message         // protocol messages (InviteMessage)
```

### Files and Error Codes

```typescript
// Files: kebab-case, tests use *.test.ts
environment-builder.ts
admission.test.ts

// Error codes: SCREAMING_SNAKE_CASE
export const ErrorCodes = { DECLINED: 'DECLINED', TASK_FAILED: 'TASK_FAILED' } as const;

// States: lowercase
type DelegationState = 'created' | 'invited' | 'accepted' | 'running' | 'completed';
```

---

## Type Definitions

### Type vs Interface

```typescript
// Use `type` for: unions, literals, derived types
type AccessMode = 'ro' | 'rw';
type DelegationState = 'created' | 'invited' | 'accepted' | ...;
type AwcpMessage = InviteMessage | AcceptMessage | StartMessage | ...;

// Use `interface` for: objects, configs, APIs
interface TaskSpec { description: string; prompt: string; }
interface TransportAdapter {
  readonly type: TransportType;
  prepare(params: TransportPrepareParams): Promise<TransportPrepareResult>;
}
```

### Configuration Pattern

```typescript
// User config: optional fields
export interface DelegatorConfig {
  environment: EnvironmentConfig;       // required
  transport: DelegatorTransportAdapter; // required
  admission?: AdmissionConfig;          // optional
}

// Resolved config: all required (after applying defaults)
export interface ResolvedDelegatorConfig {
  environment: EnvironmentConfig;
  transport: DelegatorTransportAdapter;
  admission: ResolvedAdmissionConfig;   // now required
}

// Resolve function applies defaults using ?? operator
export function resolveDelegatorConfig(config: DelegatorConfig): ResolvedDelegatorConfig;
```

### Type-only Imports

```typescript
// Always use `type` for type-only imports
import type { Delegation, TaskSpec } from '@awcp/core';

// Mixed imports: separate type and value
import { DelegationStateMachine, type Delegation, PROTOCOL_VERSION } from '@awcp/core';
```

---

## Module Organization

### Import Order

```typescript
// 1. Node.js built-ins (use node: protocol)
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';

// 2. External dependencies
import archiver from 'archiver';

// 3. Internal packages (@awcp/*)
import { AwcpError, type Delegation } from '@awcp/core';

// 4. Relative imports (must include .js extension)
import { AdmissionController } from './admission.js';
```

### Export Patterns

```typescript
// packages/core/src/index.ts - top-level barrel
export * from './types/index.js';
export * from './errors/index.js';
export { DelegationStateMachine, isTerminalState } from './state-machine/index.js';

// packages/sdk/src/index.ts - grouped exports with section comments
// --- Delegator API ---
export { DelegatorService, type DelegatorConfig } from './delegator/index.js';
// --- Executor API ---
export { ExecutorService, type ExecutorConfig } from './executor/index.js';

// packages/transport-*/src/index.ts - minimal exports (class + config type only)
export { ArchiveTransport } from './archive-transport.js';
export type { ArchiveTransportConfig } from './types.js';
```

---

## Error Handling

### Error Class Hierarchy

```typescript
// Base class
export class AwcpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly hint?: string,
    public readonly delegationId?: string,
  ) { super(message); this.name = 'AwcpError'; }
}

// Specialized errors add context-specific fields
export class WorkspaceTooLargeError extends AwcpError {
  constructor(public readonly stats: { estimatedBytes?: number; fileCount?: number }, ...) {}
}
```

### When to Use Each Error Type

```typescript
throw new WorkspaceTooLargeError(stats, hint);     // specialized - protocol errors
throw new AwcpError(code, message, hint);          // base - dynamic error codes from network
throw new Error(`Unknown delegation: ${id}`);      // standard - programming errors
```

### Error Catching Patterns

```typescript
// Clean up resources on failure, then re-throw
try { ... } catch (error) { await this.cleanup(delegationId); throw error; }

// Silent cleanup (don't fail if cleanup fails)
await this.transport.teardown({ delegationId }).catch(() => {});

// Type checking
if (error instanceof WorkspaceTooLargeError) { console.log(error.stats); }
```

### Logging Format

```typescript
// Use [AWCP:Component] prefix
console.log('[AWCP:Delegator] Subscribing to SSE...');
console.error('[AWCP:Executor] Error handling message:', error);
```

---

## Comments and Documentation

### File Headers

```typescript
/**
 * @awcp/core
 *
 * AWCP Protocol Core - Types, State Machine, and Error Definitions
 */
```

### Interface Documentation

```typescript
/**
 * Admission control configuration
 */
export interface AdmissionConfig {
  /** Maximum total bytes allowed */
  maxTotalBytes?: number;
}
```

### Inline Comments

```typescript
// Use sparingly - explain WHY, not WHAT

// Normalize to absolute path
const absolutePath = path.isAbsolute(localDir) ? localDir : path.resolve(process.cwd(), localDir);

// Fail open for usability - real implementations may want to fail closed
return { allowed: true };
```

### TODO and Section Separators

```typescript
// TODO: <description>
| { type: 'EXPIRE' };  // TODO: Implement lease expiration timer

// Heavy separator for major sections
// ========== Delegator Side ==========

// Light separator for subsections
// --- Task Events (SSE Streaming) ---
```

---

## Testing

### Framework and Structure

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('DelegationStateMachine', () => {
  describe('initial state', () => {
    it('should start in created state by default', () => {});
  });
  describe('error handling', () => {
    it('should transition to error state on RECEIVE_ERROR', () => {});
  });
});

// Test naming: should + verb + expected result
it('should reject when file count exceeds limit', () => {});
it('should not allow cancellation from terminal state', () => {});
```

### Common Patterns

```typescript
// Assertions
expect(value).toBe(expected);
expect(result.hint).toContain('File count');
expect(sm.transition({ type: 'SEND_INVITE' })).toMatchObject({ success: true });
await expect(controller.check('/invalid')).rejects.toThrow();

// Temporary files
let testDir: string;
beforeEach(async () => {
  testDir = join(tmpdir(), `awcp-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});
afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

// Mocking fetch
beforeEach(() => { originalFetch = global.fetch; });
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });
global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
```

---

## API Design Patterns

### Service Class Structure

```typescript
export class DelegatorService {
  private config: ResolvedDelegatorConfig;           // 1. Private resolved config
  private transport: DelegatorTransportAdapter;      // 2. Dependencies
  private delegations = new Map<string, Delegation>(); // 3. State

  constructor(options: DelegatorServiceOptions) {    // 4. Constructor resolves config
    this.config = resolveDelegatorConfig(options.config);
  }

  async delegate(params: DelegateParams): Promise<string> {} // 5. Public async API
  async handleMessage(message: AwcpMessage): Promise<void> {} // 6. Message handlers
  getDelegation(id: string): Delegation | undefined {}       // 7. Sync query methods
  private async cleanup(delegationId: string): Promise<void> {} // 8. Private helpers
}
```

### Hook Pattern

```typescript
// All hooks optional, on* prefix
export interface ExecutorHooks {
  onInvite?: (invite: InviteMessage) => Promise<boolean>;  // decision hook
  onTaskStart?: (context: TaskStartContext) => void;       // notification hook
}

// Call with optional chaining
this.config.hooks.onDelegationCreated?.(delegation);
```

### Adapter Pattern

```typescript
// Interface in @awcp/core
export interface TransportAdapter {
  readonly type: TransportType;
  prepare(params: TransportPrepareParams): Promise<TransportPrepareResult>;  // Delegator
  setup(params: TransportSetupParams): Promise<string>;                      // Executor
  cleanup(delegationId: string): Promise<void>;
}

// Implementation in transport package
export class SshfsTransport implements TransportAdapter {
  readonly type = 'sshfs' as const;
}
```

---

## Adding New Features

### New Transport

1. Create `packages/transport-{name}/`
2. Implement `TransportAdapter` from `@awcp/core`
3. Export only: `{Name}Transport` class + `{Name}TransportConfig` type
4. Add tests in `test/`
5. Add integration scenario in `experiments/scenarios/`

### New Error Type

1. Add error code to `ErrorCodes` in `@awcp/core`
2. Create error class extending `AwcpError`
3. Include: code, message, hint, delegationId
4. Export from `@awcp/core`

### New Message Field

1. Add optional field to interface in `@awcp/core`
2. Add TODO comment if not yet implemented
3. Update handlers in `@awcp/sdk` if needed

---

## Common Pitfalls

| Don't | Do |
|-------|-----|
| `enum ErrorCode { ... }` | `const ErrorCodes = { ... } as const` |
| `interface ITransportAdapter` | `interface TransportAdapter` |
| `import { foo } from './bar'` | `import { foo } from './bar.js'` |
| `export type { ResolvedConfig }` | Keep internal types unexported |
| `config.timeout \|\| 30` | `config.timeout ?? 30` |
| `catch (e) { /* empty */ }` | `catch (e) { console.error(...); throw e; }` |
| `async function delegateAsync()` | `async function delegate()` |

---

## Quick Reference

| Category | Convention | Example |
|----------|------------|---------|
| Local variable | camelCase | `delegationId` |
| Constant | SCREAMING_SNAKE | `PROTOCOL_VERSION` |
| Class | PascalCase + Suffix | `DelegatorService` |
| Interface | PascalCase (no I) | `TransportAdapter` |
| Type alias | PascalCase | `AccessMode` |
| Error code | SCREAMING_SNAKE | `WORKSPACE_TOO_LARGE` |
| State | lowercase | `running` |
| File | kebab-case | `executor-client.ts` |
| Test file | *.test.ts | `admission.test.ts` |
| Hook | on* prefix | `onTaskStart` |
| Config | *Config suffix | `DelegatorConfig` |

## Useful Links

- [Protocol Specification](docs/v1.md)
- [MCP Tools Reference](packages/mcp/README.md)
- [Example Executor](examples/synergy-executor/README.md)
