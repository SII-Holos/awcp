# AWCP Archive Transport: Chunked Transfer Implementation

When delegating workspaces that exceed a few megabytes, AWCP's default inline base64 transfer becomes impractical. Network timeouts, body parser limits, and memory pressure all conspire against large payload delivery. The chunked transport feature solves this by breaking large archives into manageable pieces, uploading them in parallel, and reassembling them on the Executor side.

This document covers the design, implementation challenges, and technical details of chunked transfer.

---

## 1. Overview

### What is Chunked Transport?

Chunked transport is an extension to the Archive Transport that handles large workspace transfers by:

1. **Splitting** the ZIP archive into fixed-size chunks (default: 512KB)
2. **Computing** SHA-256 checksums for integrity verification
3. **Uploading** chunks in parallel with retry support
4. **Reassembling** the archive on the Executor before extraction

### When is Chunked Mode Triggered?

The decision is automatic based on archive size:

```
Archive Size < chunkThreshold  →  Inline base64 (original behavior)
Archive Size ≥ chunkThreshold  →  Chunked transfer
```

The default threshold is **2MB**, deliberately low to facilitate testing. Production deployments may increase this to 10MB or higher.

### High-Level Architecture

```
┌─────────────────────┐                    ┌─────────────────────┐
│     DELEGATOR       │                    │      EXECUTOR       │
├─────────────────────┤                    ├─────────────────────┤
│                     │                    │                     │
│  ┌───────────────┐  │                    │  ┌───────────────┐  │
│  │ArchiveTransport│ │                    │  │ArchiveTransport│ │
│  │               │  │                    │  │               │  │
│  │  prepare()    │──┼── START message ──►│  │  initChunk    │  │
│  │  [creates ZIP]│  │    (chunked info)  │  │  Receiver()   │  │
│  │               │  │                    │  │               │  │
│  │  ChunkUploader│──┼── POST /chunks ───►│  │ ChunkReceiver │  │
│  │  [parallel]   │  │    [chunk data]    │  │ [stores temp] │  │
│  │               │  │                    │  │               │  │
│  │               │──┼── POST /complete ─►│  │  assemble()   │  │
│  │               │  │                    │  │               │  │
│  └───────────────┘  │                    │  │  setup()      │  │
│                     │                    │  │  [extracts]   │  │
└─────────────────────┘                    └─────────────────────┘
```

---

## 2. Problems Encountered & Solutions

Building chunked transfer surfaced several non-obvious issues. Understanding these helps maintainers debug future problems and informs design decisions for similar features.

### Problem 1: JSON Body Parser Limit

**Symptom**: Large base64 payloads rejected with `413 Payload Too Large` or silent connection resets.

**Root Cause**: Express's default `body-parser` limit is 100KB. Even a single 512KB chunk encoded as base64 (~683KB) exceeds this dramatically.

**Solution**: Increased the JSON body parser limit to 50MB in all HTTP endpoints that receive AWCP messages or chunk data.

**Files Modified**:
- `packages/sdk/src/listener/http-listener.ts:30`
- `packages/sdk/src/delegator/bin/daemon.ts:41`

```typescript
// http-listener.ts
this.router.use(json({ limit: '50mb' }));

// daemon.ts  
app.use(json({ limit: '50mb' }));
```

**Why 50MB?** This accommodates the largest reasonable chunk size (chunkSize × base64 overhead) while still protecting against accidental memory exhaustion. The actual chunk data is much smaller, but the limit provides headroom for protocol evolution.

---

### Problem 2: Request Timeout

**Symptom**: Uploads fail with `AbortError: This operation was aborted` after ~30 seconds, even when the network is healthy.

**Root Cause**: The default `fetch()` timeout (typically 30 seconds) is insufficient for large transfers, especially when:
- Network latency is high
- The Executor is under load
- Multiple chunks upload concurrently

**Solution**: Increased the HTTP client timeout to 5 minutes (300,000ms) for all AWCP operations.

**Files Modified**:
- `packages/sdk/src/delegator/bin/client.ts:82`
- `packages/sdk/src/delegator/executor-client.ts:21`

```typescript
// executor-client.ts
constructor(options?: ExecutorClientOptions) {
  this.timeout = options?.timeout ?? 300000; // 5 minutes for large transfers
}

// client.ts (DelegatorDaemonClient)
constructor(daemonUrl: string, options?: { timeout?: number }) {
  this.timeout = options?.timeout ?? 300000; // 5 minutes for large file transfers
}
```

**Note**: Individual chunk uploads have their own configurable timeout (`chunkTimeout`, default 30s) that applies per-chunk, not to the entire transfer.

---

### Problem 3: Deadlock in START Handler

This was the most subtle bug—a classic async coordination failure.

**Symptom**: 
- Executor receives START message with chunked info
- Executor initializes ChunkReceiver
- Delegator attempts to upload chunks
- Uploads fail with connection refused or timeout
- Eventually both sides time out

**Root Cause**: The original implementation called `waitForChunks()` synchronously inside `handleStart()`:

```typescript
// BROKEN: handleStart() is called from HTTP request handler
async handleStart(start: StartMessage): Promise<void> {
  // ... setup ...
  
  if (isChunked) {
    archiveTransport.initChunkReceiver(delegationId, chunkedInfo);
    await this.waitForChunks(delegationId);  // BLOCKS HERE
  }
  
  // HTTP response never sent!
  await this.executeTask(...);
}
```

The problem: `handleStart()` runs inside the HTTP request handler. Calling `await waitForChunks()` blocks the handler from returning, so the HTTP response is never sent. Meanwhile, the Delegator is waiting for the START response before uploading chunks. **Deadlock.**

**Solution**: Separate the HTTP response from chunk waiting. Return immediately from the START handler, then wait for chunks asynchronously before task execution.

```typescript
// FIXED: Return immediately, wait asynchronously
async handleStart(start: StartMessage): Promise<void> {
  // ... setup ...
  
  if (isChunked) {
    archiveTransport.initChunkReceiver(delegationId, chunkedInfo);
    // DON'T await here - return so HTTP response is sent
  }
  
  // Task execution runs async - don't await
  // Chunked transfer will be awaited inside executeTaskWithChunkWait
  this.executeTaskWithChunkWait(
    delegationId, start, workPath, task, lease, environment, eventEmitter, isChunked
  );
}

private async executeTaskWithChunkWait(..., isChunked: boolean): Promise<void> {
  if (isChunked) {
    await this.waitForChunks(delegationId);  // Safe to await here
  }
  await this.executeTask(...);
}
```

**File Modified**: `packages/sdk/src/executor/service.ts`

---

### Problem 4: File Collision Between Delegator and Executor

**Symptom**: Archive extraction fails with `ENOENT: no such file or directory` immediately after successful chunk assembly.

**Root Cause**: Both Delegator and Executor used the same temp directory path pattern:

```typescript
// Delegator (archive-transport.ts)
const archivePath = path.join(this.tempDir, `${delegationId}.zip`);

// Executor (chunk-receiver.ts)
const archivePath = path.join(this.tempDir, `${delegationId}.zip`);
```

When running on the same machine (common in development/testing), `tempDir` defaults to the same location. After the Delegator finishes uploading, it cleans up its archive file—which happens to be the exact file the Executor just assembled!

**Solution**: Differentiate the Delegator's archive filename:

```typescript
// archive-transport.ts prepare()
const archivePath = path.join(this.tempDir, `${delegationId}-delegator.zip`);
```

**File Modified**: `packages/transport-archive/src/archive-transport.ts:89`

**Lesson**: When two components share temp directories, ensure unique filenames. Consider using random suffixes or component-specific subdirectories.

---

## 3. Chunked Transport Technical Details

### 3.1 Configuration

Configuration is split between Delegator and Executor sides:

```typescript
// packages/transport-archive/src/types.ts

export interface ArchiveDelegatorConfig {
  tempDir?: string;
  chunkThreshold?: number;    // Archive size threshold for chunked mode
  chunkSize?: number;         // Size of each chunk
  uploadConcurrency?: number; // Parallel upload count (0 = serial)
  chunkRetries?: number;      // Retry count per failed chunk
  chunkTimeout?: number;      // Timeout per chunk upload (ms)
}

export interface ArchiveExecutorConfig {
  tempDir?: string;
  chunkReceiveTimeout?: number; // Total timeout for receiving all chunks
}

// Default values
export const DEFAULT_DELEGATOR_CONFIG = {
  chunkThreshold: 2 * 1024 * 1024,   // 2MB (low for testing)
  chunkSize: 512 * 1024,             // 512KB per chunk
  uploadConcurrency: 3,              // 3 parallel uploads
  chunkRetries: 3,                   // 3 retries per chunk
  chunkTimeout: 30000,               // 30s per chunk
} as const;

export const DEFAULT_EXECUTOR_CONFIG = {
  chunkReceiveTimeout: 5 * 60 * 1000, // 5 minutes total
} as const;
```

**Tuning Guidance**:
- Increase `chunkThreshold` in production (10-50MB) to avoid chunking overhead for medium files
- Increase `chunkSize` for fast networks, decrease for unreliable connections
- Reduce `uploadConcurrency` if the Executor has limited bandwidth or connections
- Increase `chunkReceiveTimeout` for very large workspaces

### 3.2 Protocol Flow

```
Delegator                              Executor
    │                                      │
    │ ─── INVITE ─────────────────────────►│
    │ ◄── ACCEPT ──────────────────────────│
    │                                      │
    │  [prepare() creates archive]         │
    │  [archive > threshold → chunked]     │
    │  [compute checksums]                 │
    │                                      │
    │ ─── START {chunked: ChunkedInfo} ───►│  initChunkReceiver()
    │ ◄── {ok: true} ──────────────────────│  (returns immediately)
    │                                      │
    │  [uploadChunks() begins]             │  waitForChunks() (async)
    │ ─── POST /chunks/:id [chunk 0] ─────►│  receive() validates & stores
    │ ─── POST /chunks/:id [chunk 1] ─────►│  receive()
    │ ─── POST /chunks/:id [chunk 2] ─────►│  receive()
    │     (parallel, up to concurrency)    │
    │ ─── POST /chunks/:id [chunk N] ─────►│  receive()
    │                                      │
    │ ─── POST /chunks/:id/complete ──────►│  assemble() + resolve waitForChunks
    │ ◄── {ok: true, assembled: true} ─────│
    │                                      │
    │                                      │  setup() extracts archive
    │                                      │  executeTask()
    │                                      │
    │ ◄── SSE: status (running) ───────────│
    │ ◄── SSE: snapshot ───────────────────│
    │ ◄── SSE: done ───────────────────────│
```

**Key Insight**: The START message contains only metadata (`ChunkedInfo`), not the actual data. This keeps the START request small and fast, deferring the heavy transfer to dedicated chunk endpoints.

### 3.3 Key Data Structures

#### ChunkedArchiveInfo (in START message)

Defined in `@awcp/core`:

```typescript
// packages/core/src/types/messages.ts

export interface ChunkedArchiveInfo {
  /** Total archive size in bytes */
  totalSize: number;
  /** Size of each chunk in bytes */
  chunkSize: number;
  /** Total number of chunks */
  chunkCount: number;
  /** SHA-256 of complete archive (hex) */
  totalChecksum: string;
  /** SHA-256 of each chunk (hex array) */
  chunkChecksums: string[];
}
```

This metadata travels in the `workDir` field of the START message:

```typescript
export interface ArchiveWorkDirInfo {
  transport: 'archive';
  /** Small files: inline base64 (backward compatible) */
  workspaceBase64?: string;
  /** Large files: chunked transfer metadata */
  chunked?: ChunkedArchiveInfo;
  /** Checksum of complete archive */
  checksum: string;
}
```

#### Chunk Upload Request Body

```typescript
// POST /awcp/chunks/:delegationId
interface ChunkUploadRequest {
  index: number;      // 0-based chunk index
  data: string;       // Base64 encoded chunk data
  checksum: string;   // SHA-256 of this chunk (hex)
}
```

### 3.4 Key Components

#### ChunkUploader (Delegator Side)

`packages/transport-archive/src/chunk-uploader.ts`

Responsibilities:
- Read archive file in chunks using streaming file I/O
- Upload chunks with configurable concurrency
- Retry failed chunks with exponential backoff
- Query status for resume support
- Call complete endpoint when all chunks uploaded

```typescript
export class ChunkUploader {
  async upload(
    archivePath: string,
    chunkedInfo: ChunkedArchiveInfo,
    target: UploadTarget,
    skipIndices: number[] = []  // For resume support
  ): Promise<void>;
  
  async complete(target: UploadTarget, totalChecksum: string): Promise<void>;
  
  async getStatus(target: UploadTarget): Promise<{ received: number[]; missing: number[] }>;
}
```

**Implementation Notes**:
- Uses `fs.promises.open()` for efficient random-access reads
- Worker pool pattern for parallel uploads
- Each chunk verified locally before upload (catches disk corruption)

#### ChunkReceiver (Executor Side)

`packages/transport-archive/src/chunk-receiver.ts`

Responsibilities:
- Receive and validate incoming chunks
- Store chunks as temporary files
- Track received vs missing chunks
- Assemble chunks into final archive
- Timeout handling with automatic cleanup

```typescript
export class ChunkReceiver {
  async receive(index: number, base64Data: string, checksum: string): Promise<void>;
  
  async assemble(totalChecksum: string): Promise<string>;  // Returns archive path
  
  getStatus(): { received: number[]; missing: number[]; complete: boolean };
  
  async cleanup(): Promise<void>;
}
```

**Implementation Notes**:
- Idempotent: receiving the same chunk twice is a no-op
- Each chunk stored as separate file (`{delegationId}-chunk-{index}`)
- Assembly verifies final archive against `totalChecksum`
- Timeout resets on each successful chunk receive

### 3.5 HTTP Endpoints

Added to `HttpListener` in `packages/sdk/src/listener/http-listener.ts`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/awcp/chunks/:delegationId` | POST | Receive a single chunk |
| `/awcp/chunks/:delegationId/status` | GET | Query received/missing chunks |
| `/awcp/chunks/:delegationId/complete` | POST | Trigger assembly |

#### Receive Chunk

```http
POST /awcp/chunks/{delegationId}
Content-Type: application/json

{
  "index": 0,
  "data": "UEsDBBQAAAAIA...",  // base64
  "checksum": "a1b2c3d4..."     // SHA-256 hex
}

Response: { "ok": true, "received": 0 }
```

#### Query Status (for Resume)

```http
GET /awcp/chunks/{delegationId}/status

Response: {
  "received": [0, 1, 3, 4],
  "missing": [2, 5],
  "complete": false
}
```

#### Complete Assembly

```http
POST /awcp/chunks/{delegationId}/complete
Content-Type: application/json

{
  "totalChecksum": "abc123..."
}

Response: { "ok": true, "assembled": true }
```

### 3.6 Checksum Verification

Integrity verification happens at multiple stages:

| Stage | Check | Error on Mismatch |
|-------|-------|-------------------|
| Chunk upload (Delegator) | Local chunk vs computed | Upload aborted |
| Chunk receive (Executor) | Received vs declared | `ChecksumMismatchError` |
| Chunk receive (Executor) | Received vs pre-announced | `ChecksumMismatchError` |
| Assembly (Executor) | Assembled file vs totalChecksum | `ChecksumMismatchError`, file deleted |

This multi-layer verification catches:
- Disk corruption during archiving
- Network corruption during transfer
- Logic bugs in chunking/reassembly

**ChecksumMismatchError** is defined in `@awcp/core`:

```typescript
export class ChecksumMismatchError extends AwcpError {
  constructor(
    public readonly expected: string,
    public readonly actual: string
  ) {
    super(
      ErrorCodes.CHECKSUM_MISMATCH,
      `Checksum mismatch: expected ${expected}, got ${actual}`
    );
  }
}
```

---

## 4. Files Modified

### New Files

| File | Purpose |
|------|---------|
| `packages/transport-archive/src/chunk-receiver.ts` | Executor-side chunk reception, validation, assembly |
| `packages/transport-archive/src/chunk-uploader.ts` | Delegator-side chunking, parallel upload, resume |

### Modified Files

| File | Changes |
|------|---------|
| `packages/core/src/types/messages.ts` | Added `ChunkedArchiveInfo`, updated `ArchiveWorkDirInfo` |
| `packages/core/src/types/service.ts` | Added `ChunkStatusResponse`, chunk methods to `ExecutorRequestHandler` |
| `packages/transport-archive/src/types.ts` | Added `ArchiveDelegatorConfig`, `ArchiveExecutorConfig`, defaults |
| `packages/transport-archive/src/archive-transport.ts` | Integrated chunked logic in `prepare()`, `setup()`, added receiver/uploader management |
| `packages/sdk/src/executor/service.ts` | Added chunk handling, `executeTaskWithChunkWait()`, `waitForChunks()` |
| `packages/sdk/src/delegator/service.ts` | Trigger chunk upload after START in `handleAccept()` |
| `packages/sdk/src/listener/http-listener.ts` | Added chunk HTTP endpoints, increased body parser limit |
| `packages/sdk/src/delegator/bin/daemon.ts` | Increased body parser limit |
| `packages/sdk/src/delegator/bin/client.ts` | Increased timeout |
| `packages/sdk/src/delegator/executor-client.ts` | Increased timeout |

---

## 5. Testing

### Test Scenario

The chunked transfer feature is exercised by:

```
experiments/scenarios/09-multimodal-test/
```

This scenario uses a ~6MB workspace containing 100+ images, which reliably triggers chunked mode with the default 2MB threshold.

### Running the Test

```bash
cd experiments/scenarios/09-multimodal-test
./run.sh
```

**What to Watch For**:

1. Executor log shows chunk receiver initialization:
   ```
   [AWCP:Executor] Initialized chunk receiver for: del_xxx
   [AWCP:Executor] Waiting for chunked transfer: del_xxx
   ```

2. Delegator log shows chunked upload:
   ```
   [AWCP:Delegator] Starting chunked upload for del_xxx
   [AWCP:Delegator] Chunked upload complete for del_xxx
   ```

3. No timeout errors during transfer

4. Task executes successfully after chunks assembled

### Manual Testing with Lowered Threshold

For testing with smaller workspaces, temporarily lower the threshold:

```typescript
const transport = new ArchiveTransport({
  delegator: {
    chunkThreshold: 100 * 1024,  // 100KB - triggers chunking easily
    chunkSize: 32 * 1024,        // 32KB chunks - more chunks to observe
  }
});
```

### Observing Chunk Progress

Check chunk status during transfer:

```bash
curl http://localhost:4001/awcp/chunks/${DELEGATION_ID}/status
```

Response shows progress:
```json
{
  "received": [0, 1, 2, 3, 4],
  "missing": [5, 6, 7, 8, 9],
  "complete": false
}
```

---

## 6. Future Improvements

The current implementation is functional but has room for enhancement:

**Resume Support**: The infrastructure exists (`getStatus()`, `skipIndices`) but isn't wired to automatic retry on connection failure. A future version could detect incomplete transfers and resume from the last successful chunk.

**Streaming Assembly**: Currently, all chunks are written to separate temp files, then read sequentially into the final archive. For very large transfers, a streaming approach that pipes chunks directly would reduce I/O.

**Compression**: Chunks could be compressed (gzip/brotli) before base64 encoding. For already-compressed content (images, videos), this wastes CPU; for text/code, it could significantly reduce transfer size.

**Progress Reporting**: The protocol could emit progress events during chunked transfer, allowing the Delegator to display upload progress to users.

---

## Appendix: Error Recovery

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Single chunk upload fails | HTTP error or timeout | Automatic retry (up to `chunkRetries`) |
| All retries exhausted | Exception from `uploadChunk()` | Entire delegation fails with error |
| Chunk checksum mismatch | `ChecksumMismatchError` | Chunk rejected, retry uploads |
| Assembly checksum mismatch | `ChecksumMismatchError` | Assembled file deleted, error propagated |
| Receive timeout | Timer fires in `ChunkReceiver` | Temp files cleaned up, delegation fails |
| Delegator disconnects | Missing complete call | Eventually times out on Executor |

The design prioritizes **correctness over availability**: any integrity issue causes immediate failure rather than attempting to continue with potentially corrupted data.
