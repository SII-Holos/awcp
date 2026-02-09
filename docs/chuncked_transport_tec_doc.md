# Archive Transport 分块传输技术方案

## 1. 概述

### 1.1 背景

Archive Transport 当前将整个工作区 ZIP 文件进行 base64 编码后内嵌在 JSON 消息体中传输，当文件较大时会遇到：
- HTTP body size 限制（Nginx 等中间层）
- 内存占用过高
- 传输失败需要全部重来

### 1.2 目标

- 大文件自动分块传输，小文件保持原有逻辑（向后兼容）
- 流式处理，降低内存占用
- 支持断点续传
- 可配置的并发/串行上传

### 1.3 设计原则

- 最小改动，只修改 Transport 层
- 对使用方透明，无需改动业务代码
- 向后兼容，小文件走原有逻辑

---

## 2. 整体流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│  小文件 (< chunkThreshold)：保持原有流程                                  │
│                                                                         │
│  Delegator                                    Executor                  │
│      │─── START { workDir: { workspaceBase64: "..." } } ──►│            │
│      │─── GET /tasks/:id/events (SSE) ───────────────────►│            │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  大文件 (>= chunkThreshold)：分块传输                                    │
│                                                                         │
│  Delegator                                    Executor                  │
│      │                                            │                     │
│      │─── START { workDir: { chunked: {...} }} ──►│  返回 { ok: true }  │
│      │                                            │  创建 ChunkReceiver │
│      │                                            │                     │
│      │─── POST /chunks/:id { index:0, data } ────►│  存储分块 0         │
│      │◄── { ok: true, received: 0 } ─────────────│                     │
│      │                                            │                     │
│      │─── POST /chunks/:id { index:1, data } ────►│  存储分块 1         │
│      │◄── { ok: true, received: 1 } ─────────────│                     │
│      │         ... (可并发)                       │                     │
│      │                                            │                     │
│      │─── POST /chunks/:id/complete ─────────────►│  组装 + 校验        │
│      │◄── { ok: true, assembled: true } ─────────│  触发任务执行       │
│      │                                            │                     │
│      │─── GET /tasks/:id/events (SSE) ───────────►│  执行任务...        │
│      │                                            │                     │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  断点续传流程                                                            │
│                                                                         │
│  Delegator                                    Executor                  │
│      │                                            │                     │
│      │  (上传中断后重连)                           │                     │
│      │                                            │                     │
│      │─── GET /chunks/:id/status ────────────────►│                     │
│      │◄── { received: [0,1,3], missing: [2,4] } ──│                     │
│      │                                            │                     │
│      │─── POST /chunks/:id { index:2, data } ────►│  补传缺失块         │
│      │─── POST /chunks/:id { index:4, data } ────►│                     │
│      │                                            │                     │
│      │─── POST /chunks/:id/complete ─────────────►│                     │
│      │                                            │                     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 文件变更清单

| 文件路径 | 变更类型 | 描述 |
|----------|----------|------|
| `packages/core/src/types/messages.ts` | 修改 | 新增 `ChunkedArchiveInfo`，扩展 `ArchiveWorkDirInfo` |
| `packages/core/src/types/executor.ts` | 修改 | `ExecutorRequestHandler` 新增分块相关方法 |
| `packages/core/src/index.ts` | 修改 | 导出新类型 |
| `packages/transport-archive/src/types.ts` | 修改 | 扩展配置类型 |
| `packages/transport-archive/src/archive-transport.ts` | 修改 | 实现分块逻辑 |
| `packages/transport-archive/src/chunk-receiver.ts` | **新增** | 分块接收器类 |
| `packages/transport-archive/src/chunk-uploader.ts` | **新增** | 分块上传器类（流式读取） |
| `packages/transport-archive/src/utils/index.ts` | 修改 | 导出新工具 |
| `packages/sdk/src/listener/http-listener.ts` | 修改 | 新增分块相关 HTTP 端点 |
| `packages/sdk/src/executor/service.ts` | 修改 | 处理分块接收和任务触发 |
| `packages/sdk/src/delegator/service.ts` | 修改 | START 后触发分块上传 |

---

## 4. 详细变更

### 4.1 `packages/core/src/types/messages.ts`

**新增类型定义**（在 `ArchiveWorkDirInfo` 之前）：

```typescript
/**
 * 分块传输元数据
 */
export interface ChunkedArchiveInfo {
  /** 原始 ZIP 文件大小 (bytes) */
  totalSize: number;
  /** 每块大小 (bytes) */
  chunkSize: number;
  /** 分块总数 */
  chunkCount: number;
  /** 整体 SHA256 校验和 */
  totalChecksum: string;
  /** 每个分块的 SHA256 校验和 */
  chunkChecksums: string[];
}
```

**修改 `ArchiveWorkDirInfo`**：

```typescript
export interface ArchiveWorkDirInfo {
  transport: 'archive';
  /** 小文件：内联 base64（向后兼容） */
  workspaceBase64?: string;
  /** 大文件：分块传输元数据 */
  chunked?: ChunkedArchiveInfo;
  /** 整体校验和（两种模式都需要） */
  checksum: string;
}
```

---

### 4.2 `packages/core/src/types/executor.ts`

**在 `ExecutorRequestHandler` 接口中新增方法**：

```typescript
export interface ExecutorRequestHandler {
  // ... 现有方法保持不变 ...

  /**
   * 接收单个分块
   */
  receiveChunk(delegationId: string, index: number, data: string, checksum: string): Promise<void>;

  /**
   * 完成分块传输，触发组装
   */
  completeChunks(delegationId: string, totalChecksum: string): Promise<void>;

  /**
   * 获取分块接收状态（用于断点续传）
   */
  getChunkStatus(delegationId: string): ChunkStatusResponse;
}

/**
 * 分块状态响应
 */
export interface ChunkStatusResponse {
  /** 是否存在该 delegation 的分块接收器 */
  exists: boolean;
  /** 已接收的分块索引 */
  received: number[];
  /** 缺失的分块索引 */
  missing: number[];
  /** 是否已完成 */
  complete: boolean;
}
```

---

### 4.3 `packages/core/src/index.ts`

**确保导出新类型**（通常通过 `types/index.ts` 自动导出，检查是否需要手动添加）：

```typescript
export type { ChunkedArchiveInfo, ChunkStatusResponse } from './types/index.js';
```

---

### 4.4 `packages/transport-archive/src/types.ts`

**完整替换为**：

```typescript
/**
 * Archive Transport Configuration Types
 */

export { ArchiveWorkDirInfo, ChunkedArchiveInfo } from '@awcp/core';

export interface ArchiveDelegatorConfig {
  /** 临时文件目录 */
  tempDir?: string;
  /** 分块阈值 (bytes)，超过此值启用分块传输，默认 10MB */
  chunkThreshold?: number;
  /** 单块大小 (bytes)，默认 2MB */
  chunkSize?: number;
  /** 并发上传数量，0 表示串行，默认 3 */
  uploadConcurrency?: number;
  /** 单块上传重试次数，默认 3 */
  chunkRetries?: number;
  /** 单块上传超时 (ms)，默认 30000 */
  chunkTimeout?: number;
}

export interface ArchiveExecutorConfig {
  /** 临时文件目录 */
  tempDir?: string;
  /** 分块接收超时 (ms)，默认 5 分钟 */
  chunkReceiveTimeout?: number;
}

export interface ArchiveTransportConfig {
  delegator?: ArchiveDelegatorConfig;
  executor?: ArchiveExecutorConfig;
}

/**
 * 默认配置值
 */
export const DEFAULT_DELEGATOR_CONFIG = {
  chunkThreshold: 10 * 1024 * 1024,  // 10MB
  chunkSize: 2 * 1024 * 1024,        // 2MB
  uploadConcurrency: 3,              // 并发 3 个
  chunkRetries: 3,
  chunkTimeout: 30000,
} as const;

export const DEFAULT_EXECUTOR_CONFIG = {
  chunkReceiveTimeout: 5 * 60 * 1000, // 5 分钟
} as const;
```

---

### 4.5 `packages/transport-archive/src/chunk-receiver.ts`

**新建文件**：

```typescript
/**
 * Chunk Receiver - Executor 侧分块接收器
 *
 * 负责接收、校验、存储分块，并在所有分块到达后组装成完整文件。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { ChunkedArchiveInfo } from '@awcp/core';
import { ChecksumMismatchError } from '@awcp/core';

export interface ChunkReceiverConfig {
  delegationId: string;
  tempDir: string;
  chunkedInfo: ChunkedArchiveInfo;
  timeoutMs: number;
}

export class ChunkReceiver {
  private config: ChunkReceiverConfig;
  private receivedChunks = new Map<number, string>(); // index -> tempFilePath
  private complete = false;
  private assembledPath?: string;
  private timeoutTimer?: ReturnType<typeof setTimeout>;

  constructor(config: ChunkReceiverConfig) {
    this.config = config;
    this.startTimeout();
  }

  /**
   * 接收单个分块
   */
  async receive(index: number, base64Data: string, checksum: string): Promise<void> {
    if (this.complete) {
      throw new Error('Chunk receiver already complete');
    }

    const { chunkCount, chunkChecksums } = this.config.chunkedInfo;

    if (index < 0 || index >= chunkCount) {
      throw new Error(`Invalid chunk index: ${index}, expected 0-${chunkCount - 1}`);
    }

    if (this.receivedChunks.has(index)) {
      // 幂等：已接收则跳过
      return;
    }

    // 解码并校验分块
    const buffer = Buffer.from(base64Data, 'base64');
    const actualChecksum = crypto.createHash('sha256').update(buffer).digest('hex');

    if (actualChecksum !== checksum) {
      throw new ChecksumMismatchError(checksum, actualChecksum);
    }

    if (actualChecksum !== chunkChecksums[index]) {
      throw new ChecksumMismatchError(chunkChecksums[index]!, actualChecksum);
    }

    // 存储到临时文件
    await fs.promises.mkdir(this.config.tempDir, { recursive: true });
    const chunkPath = path.join(
      this.config.tempDir,
      `${this.config.delegationId}-chunk-${index}`
    );
    await fs.promises.writeFile(chunkPath, buffer);
    this.receivedChunks.set(index, chunkPath);

    // 重置超时
    this.resetTimeout();
  }

  /**
   * 组装所有分块为完整文件
   */
  async assemble(totalChecksum: string): Promise<string> {
    const { chunkCount, totalChecksum: expectedChecksum } = this.config.chunkedInfo;

    if (this.receivedChunks.size !== chunkCount) {
      const missing = this.getMissingIndices();
      throw new Error(`Missing chunks: ${missing.join(', ')}`);
    }

    if (totalChecksum !== expectedChecksum) {
      throw new ChecksumMismatchError(expectedChecksum, totalChecksum);
    }

    this.clearTimeout();

    // 按顺序组装
    const archivePath = path.join(this.config.tempDir, `${this.config.delegationId}.zip`);
    const writeStream = fs.createWriteStream(archivePath);

    for (let i = 0; i < chunkCount; i++) {
      const chunkPath = this.receivedChunks.get(i)!;
      const chunkData = await fs.promises.readFile(chunkPath);
      writeStream.write(chunkData);
      // 清理分块临时文件
      await fs.promises.unlink(chunkPath).catch(() => {});
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.end((err: Error | null) => (err ? reject(err) : resolve()));
    });

    // 校验组装后的文件
    const buffer = await fs.promises.readFile(archivePath);
    const actualChecksum = crypto.createHash('sha256').update(buffer).digest('hex');

    if (actualChecksum !== expectedChecksum) {
      await fs.promises.unlink(archivePath).catch(() => {});
      throw new ChecksumMismatchError(expectedChecksum, actualChecksum);
    }

    this.complete = true;
    this.assembledPath = archivePath;
    this.receivedChunks.clear();

    return archivePath;
  }

  /**
   * 获取状态
   */
  getStatus(): { received: number[]; missing: number[]; complete: boolean } {
    return {
      received: Array.from(this.receivedChunks.keys()).sort((a, b) => a - b),
      missing: this.getMissingIndices(),
      complete: this.complete,
    };
  }

  /**
   * 是否已完成组装
   */
  isComplete(): boolean {
    return this.complete;
  }

  /**
   * 获取组装后的文件路径
   */
  getAssembledPath(): string {
    if (!this.assembledPath) {
      throw new Error('Archive not assembled yet');
    }
    return this.assembledPath;
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    this.clearTimeout();

    // 清理分块临时文件
    for (const chunkPath of this.receivedChunks.values()) {
      await fs.promises.unlink(chunkPath).catch(() => {});
    }
    this.receivedChunks.clear();

    // 清理组装后的文件（如果存在）
    if (this.assembledPath) {
      await fs.promises.unlink(this.assembledPath).catch(() => {});
      this.assembledPath = undefined;
    }
  }

  private getMissingIndices(): number[] {
    const missing: number[] = [];
    for (let i = 0; i < this.config.chunkedInfo.chunkCount; i++) {
      if (!this.receivedChunks.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  private startTimeout(): void {
    this.timeoutTimer = setTimeout(() => this.onTimeout(), this.config.timeoutMs);
  }

  private resetTimeout(): void {
    this.clearTimeout();
    this.startTimeout();
  }

  private clearTimeout(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
  }

  private async onTimeout(): Promise<void> {
    console.warn(`[AWCP:ChunkReceiver] Timeout for ${this.config.delegationId}`);
    await this.cleanup();
  }
}
```

---

### 4.6 `packages/transport-archive/src/chunk-uploader.ts`

**新建文件**：

```typescript
/**
 * Chunk Uploader - Delegator 侧分块上传器
 *
 * 支持流式读取、并发/串行上传、单块重试、断点续传。
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type { ChunkedArchiveInfo } from '@awcp/core';

export interface ChunkUploaderConfig {
  /** 并发上传数量，0 表示串行 */
  concurrency: number;
  /** 单块重试次数 */
  retries: number;
  /** 单块上传超时 (ms) */
  timeout: number;
}

export interface UploadTarget {
  /** Executor URL */
  executorUrl: string;
  /** Delegation ID */
  delegationId: string;
}

interface ChunkMeta {
  index: number;
  offset: number;
  size: number;
  checksum: string;
}

export class ChunkUploader {
  private config: ChunkUploaderConfig;

  constructor(config: ChunkUploaderConfig) {
    this.config = config;
  }

  /**
   * 上传所有分块
   *
   * @param archivePath ZIP 文件路径
   * @param chunkedInfo 分块元数据
   * @param target 上传目标
   * @param skipIndices 跳过的分块索引（用于断点续传）
   */
  async upload(
    archivePath: string,
    chunkedInfo: ChunkedArchiveInfo,
    target: UploadTarget,
    skipIndices: number[] = []
  ): Promise<void> {
    const skipSet = new Set(skipIndices);

    // 构建需要上传的分块列表
    const chunksToUpload: ChunkMeta[] = [];
    for (let i = 0; i < chunkedInfo.chunkCount; i++) {
      if (skipSet.has(i)) continue;

      chunksToUpload.push({
        index: i,
        offset: i * chunkedInfo.chunkSize,
        size:
          i === chunkedInfo.chunkCount - 1
            ? chunkedInfo.totalSize - i * chunkedInfo.chunkSize
            : chunkedInfo.chunkSize,
        checksum: chunkedInfo.chunkChecksums[i]!,
      });
    }

    if (chunksToUpload.length === 0) {
      return;
    }

    const { concurrency } = this.config;

    if (concurrency === 0 || concurrency === 1) {
      // 串行上传
      for (const chunk of chunksToUpload) {
        await this.uploadChunk(archivePath, chunk, target);
      }
    } else {
      // 并发上传
      const queue = [...chunksToUpload];
      const workers: Promise<void>[] = [];

      for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
        workers.push(this.worker(archivePath, queue, target));
      }

      await Promise.all(workers);
    }
  }

  /**
   * 完成上传，通知 Executor 组装
   */
  async complete(target: UploadTarget, totalChecksum: string): Promise<void> {
    const url = `${target.executorUrl.replace(/\/$/, '')}/chunks/${target.delegationId}/complete`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalChecksum }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Chunk complete failed: ${response.status} ${text}`);
    }
  }

  /**
   * 查询分块状态（用于断点续传）
   */
  async getStatus(target: UploadTarget): Promise<{ received: number[]; missing: number[] }> {
    const url = `${target.executorUrl.replace(/\/$/, '')}/chunks/${target.delegationId}/status`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      // 如果 404，说明还没有开始接收
      if (response.status === 404) {
        return { received: [], missing: [] };
      }
      throw new Error(`Get chunk status failed: ${response.status}`);
    }

    return await response.json();
  }

  private async worker(
    archivePath: string,
    queue: ChunkMeta[],
    target: UploadTarget
  ): Promise<void> {
    while (queue.length > 0) {
      const chunk = queue.shift();
      if (!chunk) break;
      await this.uploadChunk(archivePath, chunk, target);
    }
  }

  private async uploadChunk(
    archivePath: string,
    chunk: ChunkMeta,
    target: UploadTarget
  ): Promise<void> {
    const { retries, timeout } = this.config;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // 流式读取分块
        const buffer = await this.readChunk(archivePath, chunk.offset, chunk.size);

        // 校验
        const actualChecksum = crypto.createHash('sha256').update(buffer).digest('hex');
        if (actualChecksum !== chunk.checksum) {
          throw new Error(`Local chunk checksum mismatch at index ${chunk.index}`);
        }

        // 上传
        const url = `${target.executorUrl.replace(/\/$/, '')}/chunks/${target.delegationId}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              index: chunk.index,
              data: buffer.toString('base64'),
              checksum: chunk.checksum,
            }),
            signal: controller.signal,
          });

          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Chunk upload failed: ${response.status} ${text}`);
          }

          return; // 成功
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        console.warn(
          `[AWCP:ChunkUploader] Chunk ${chunk.index} attempt ${attempt}/${retries} failed:`,
          error instanceof Error ? error.message : error
        );

        if (attempt === retries) {
          throw error;
        }

        // 递增延迟重试
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  /**
   * 流式读取文件的指定范围
   */
  private async readChunk(filePath: string, offset: number, size: number): Promise<Buffer> {
    const buffer = Buffer.alloc(size);
    const fileHandle = await fs.promises.open(filePath, 'r');

    try {
      await fileHandle.read(buffer, 0, size, offset);
      return buffer;
    } finally {
      await fileHandle.close();
    }
  }
}
```

---

### 4.7 `packages/transport-archive/src/archive-transport.ts`

**完整替换为**：

```typescript
/**
 * Archive Transport Adapter
 *
 * Implements TransportAdapter interface for archive-based file transfer.
 * Supports both inline base64 (small files) and chunked transfer (large files).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type {
  TransportAdapter,
  TransportCapabilities,
  TransportPrepareParams,
  TransportPrepareResult,
  TransportSetupParams,
  TransportTeardownParams,
  TransportTeardownResult,
  TransportApplySnapshotParams,
  DependencyCheckResult,
  ArchiveWorkDirInfo,
  ChunkedArchiveInfo,
} from '@awcp/core';
import { TransportError, ChecksumMismatchError } from '@awcp/core';
import { createArchive, extractArchive, applyResultToResources } from './utils/index.js';
import {
  type ArchiveTransportConfig,
  type ArchiveDelegatorConfig,
  type ArchiveExecutorConfig,
  DEFAULT_DELEGATOR_CONFIG,
  DEFAULT_EXECUTOR_CONFIG,
} from './types.js';
import { ChunkReceiver } from './chunk-receiver.js';
import { ChunkUploader } from './chunk-uploader.js';

interface ChunkedArchiveData {
  archivePath: string;
  chunkedInfo: ChunkedArchiveInfo;
}

export class ArchiveTransport implements TransportAdapter {
  readonly type = 'archive' as const;
  readonly capabilities: TransportCapabilities = {
    supportsSnapshots: true,
    liveSync: false,
  };

  private tempDir: string;
  private delegatorConfig: Required<Omit<ArchiveDelegatorConfig, 'tempDir'>>;
  private executorConfig: Required<Omit<ArchiveExecutorConfig, 'tempDir'>>;

  // Delegator 侧：存储小文件路径
  private archives = new Map<string, string>();
  // Delegator 侧：存储大文件分块数据
  private chunkedArchives = new Map<string, ChunkedArchiveData>();

  // Executor 侧：分块接收器
  private chunkReceivers = new Map<string, ChunkReceiver>();

  constructor(config: ArchiveTransportConfig = {}) {
    this.tempDir =
      config.delegator?.tempDir ?? config.executor?.tempDir ?? path.join(os.tmpdir(), 'awcp-archives');

    this.delegatorConfig = {
      chunkThreshold: config.delegator?.chunkThreshold ?? DEFAULT_DELEGATOR_CONFIG.chunkThreshold,
      chunkSize: config.delegator?.chunkSize ?? DEFAULT_DELEGATOR_CONFIG.chunkSize,
      uploadConcurrency: config.delegator?.uploadConcurrency ?? DEFAULT_DELEGATOR_CONFIG.uploadConcurrency,
      chunkRetries: config.delegator?.chunkRetries ?? DEFAULT_DELEGATOR_CONFIG.chunkRetries,
      chunkTimeout: config.delegator?.chunkTimeout ?? DEFAULT_DELEGATOR_CONFIG.chunkTimeout,
    };

    this.executorConfig = {
      chunkReceiveTimeout:
        config.executor?.chunkReceiveTimeout ?? DEFAULT_EXECUTOR_CONFIG.chunkReceiveTimeout,
    };
  }

  // ========== Delegator Side ==========

  async prepare(params: TransportPrepareParams): Promise<TransportPrepareResult> {
    const { delegationId, exportPath } = params;

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);

    await createArchive(exportPath, archivePath);

    const stats = await fs.promises.stat(archivePath);
    const totalSize = stats.size;

    // 计算总校验和（流式读取）
    const totalChecksum = await this.computeFileChecksum(archivePath);

    // 判断是否需要分块
    if (totalSize < this.delegatorConfig.chunkThreshold) {
      // 小文件：原有逻辑（内联 base64）
      const buffer = await fs.promises.readFile(archivePath);
      const base64 = buffer.toString('base64');

      this.archives.set(delegationId, archivePath);

      const workDirInfo: ArchiveWorkDirInfo = {
        transport: 'archive',
        workspaceBase64: base64,
        checksum: totalChecksum,
      };

      return { workDirInfo };
    }

    // 大文件：分块模式
    const { chunkSize } = this.delegatorConfig;
    const chunkCount = Math.ceil(totalSize / chunkSize);

    // 计算每个分块的校验和（流式读取）
    const chunkChecksums = await this.computeChunkChecksums(archivePath, chunkSize, chunkCount);

    const chunkedInfo: ChunkedArchiveInfo = {
      totalSize,
      chunkSize,
      chunkCount,
      totalChecksum,
      chunkChecksums,
    };

    this.chunkedArchives.set(delegationId, { archivePath, chunkedInfo });

    const workDirInfo: ArchiveWorkDirInfo = {
      transport: 'archive',
      chunked: chunkedInfo,
      checksum: totalChecksum,
    };

    return { workDirInfo };
  }

  /**
   * 上传所有分块到 Executor
   * 由 DelegatorService 在 sendStart 后调用
   */
  async uploadChunks(delegationId: string, executorUrl: string): Promise<void> {
    const data = this.chunkedArchives.get(delegationId);
    if (!data) {
      return; // 非分块模式，无需上传
    }

    const uploader = new ChunkUploader({
      concurrency: this.delegatorConfig.uploadConcurrency,
      retries: this.delegatorConfig.chunkRetries,
      timeout: this.delegatorConfig.chunkTimeout,
    });

    const target = { executorUrl, delegationId };

    // 查询已接收的分块（支持断点续传）
    let skipIndices: number[] = [];
    try {
      const status = await uploader.getStatus(target);
      skipIndices = status.received;
      if (skipIndices.length > 0) {
        console.log(`[AWCP:ArchiveTransport] Resuming upload, skipping chunks: ${skipIndices.join(', ')}`);
      }
    } catch {
      // 忽略查询失败
    }

    // 上传分块
    await uploader.upload(data.archivePath, data.chunkedInfo, target, skipIndices);

    // 完成上传
    await uploader.complete(target, data.chunkedInfo.totalChecksum);

    // 清理
    this.chunkedArchives.delete(delegationId);
    await fs.promises.unlink(data.archivePath).catch(() => {});
  }

  /**
   * 检查是否为分块模式
   */
  isChunkedMode(delegationId: string): boolean {
    return this.chunkedArchives.has(delegationId);
  }

  async cleanup(delegationId: string): Promise<void> {
    // 清理小文件
    const archivePath = this.archives.get(delegationId);
    if (archivePath) {
      await fs.promises.unlink(archivePath).catch(() => {});
      this.archives.delete(delegationId);
    }

    // 清理大文件
    const chunkedData = this.chunkedArchives.get(delegationId);
    if (chunkedData) {
      await fs.promises.unlink(chunkedData.archivePath).catch(() => {});
      this.chunkedArchives.delete(delegationId);
    }
  }

  async applySnapshot(params: TransportApplySnapshotParams): Promise<void> {
    const { delegationId, snapshotData, resources } = params;

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const archivePath = path.join(this.tempDir, `${delegationId}-apply.zip`);
    const extractDir = path.join(this.tempDir, `${delegationId}-apply`);

    const buffer = Buffer.from(snapshotData, 'base64');
    await fs.promises.writeFile(archivePath, buffer);

    await extractArchive(archivePath, extractDir);
    await fs.promises.unlink(archivePath);

    await applyResultToResources(extractDir, resources);

    await fs.promises.rm(extractDir, { recursive: true, force: true });
  }

  // ========== Executor Side ==========

  async checkDependency(): Promise<DependencyCheckResult> {
    return { available: true };
  }

  /**
   * 初始化分块接收器
   * 由 ExecutorService 收到 chunked START 后调用
   */
  initChunkReceiver(delegationId: string, chunkedInfo: ChunkedArchiveInfo): void {
    const receiver = new ChunkReceiver({
      delegationId,
      tempDir: this.tempDir,
      chunkedInfo,
      timeoutMs: this.executorConfig.chunkReceiveTimeout,
    });
    this.chunkReceivers.set(delegationId, receiver);
  }

  /**
   * 接收单个分块
   */
  async receiveChunk(delegationId: string, index: number, data: string, checksum: string): Promise<void> {
    const receiver = this.chunkReceivers.get(delegationId);
    if (!receiver) {
      throw new TransportError(`No chunk receiver for delegation: ${delegationId}`);
    }
    await receiver.receive(index, data, checksum);
  }

  /**
   * 完成分块接收，组装文件
   */
  async completeChunks(delegationId: string, totalChecksum: string): Promise<void> {
    const receiver = this.chunkReceivers.get(delegationId);
    if (!receiver) {
      throw new TransportError(`No chunk receiver for delegation: ${delegationId}`);
    }
    await receiver.assemble(totalChecksum);
    // 注意：不删除 receiver，setup() 需要用它获取路径
  }

  /**
   * 获取分块接收状态
   */
  getChunkStatus(delegationId: string): { exists: boolean; received: number[]; missing: number[]; complete: boolean } {
    const receiver = this.chunkReceivers.get(delegationId);
    if (!receiver) {
      return { exists: false, received: [], missing: [], complete: false };
    }
    const status = receiver.getStatus();
    return { exists: true, ...status };
  }

  async setup(params: TransportSetupParams): Promise<string> {
    const { delegationId, workDirInfo, workDir } = params;

    if (workDirInfo.transport !== 'archive') {
      throw new TransportError(`Unexpected transport type: ${workDirInfo.transport}`);
    }

    const info = workDirInfo as ArchiveWorkDirInfo;

    // 分块模式
    if (info.chunked) {
      const receiver = this.chunkReceivers.get(delegationId);
      if (!receiver || !receiver.isComplete()) {
        throw new TransportError('Chunked transfer not complete');
      }

      const archivePath = receiver.getAssembledPath();
      await extractArchive(archivePath, workDir);
      await fs.promises.unlink(archivePath).catch(() => {});
      this.chunkReceivers.delete(delegationId);

      return workDir;
    }

    // 内联模式（原有逻辑）
    if (!info.workspaceBase64) {
      throw new TransportError('Missing workspaceBase64 in non-chunked mode');
    }

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const archivePath = path.join(this.tempDir, `${delegationId}.zip`);

    const buffer = Buffer.from(info.workspaceBase64, 'base64');
    await fs.promises.writeFile(archivePath, buffer);

    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (hash !== info.checksum) {
      await fs.promises.unlink(archivePath);
      throw new ChecksumMismatchError(info.checksum, hash);
    }

    await extractArchive(archivePath, workDir);
    await fs.promises.unlink(archivePath);

    return workDir;
  }

  async teardown(params: TransportTeardownParams): Promise<TransportTeardownResult> {
    const { delegationId, workDir } = params;

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const archivePath = path.join(this.tempDir, `${delegationId}-result.zip`);

    await createArchive(workDir, archivePath, { exclude: [] });

    const buffer = await fs.promises.readFile(archivePath);
    const snapshotBase64 = buffer.toString('base64');

    await fs.promises.unlink(archivePath);

    return { snapshotBase64 };
  }

  // ========== Lifecycle ==========

  async shutdown(): Promise<void> {
    // 清理小文件
    for (const archivePath of this.archives.values()) {
      await fs.promises.unlink(archivePath).catch(() => {});
    }
    this.archives.clear();

    // 清理大文件
    for (const data of this.chunkedArchives.values()) {
      await fs.promises.unlink(data.archivePath).catch(() => {});
    }
    this.chunkedArchives.clear();

    // 清理接收器
    for (const receiver of this.chunkReceivers.values()) {
      await receiver.cleanup();
    }
    this.chunkReceivers.clear();
  }

  // ========== Private Helpers ==========

  /**
   * 流式计算文件校验和
   */
  private async computeFileChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * 流式计算各分块的校验和
   */
  private async computeChunkChecksums(
    filePath: string,
    chunkSize: number,
    chunkCount: number
  ): Promise<string[]> {
    const checksums: string[] = [];
    const fileHandle = await fs.promises.open(filePath, 'r');

    try {
      for (let i = 0; i < chunkCount; i++) {
        const buffer = Buffer.alloc(chunkSize);
        const { bytesRead } = await fileHandle.read(buffer, 0, chunkSize, i * chunkSize);
        const chunk = buffer.subarray(0, bytesRead);
        const checksum = crypto.createHash('sha256').update(chunk).digest('hex');
        checksums.push(checksum);
      }
    } finally {
      await fileHandle.close();
    }

    return checksums;
  }
}
```

---

### 4.8 `packages/transport-archive/src/utils/index.ts`

**确保导出（如果需要）**：

```typescript
// 现有导出保持不变
export { createArchive, extractArchive, applyResultToResources } from './archive-utils.js';
```

---

### 4.9 `packages/transport-archive/src/index.ts`

**确保导出新类型**：

```typescript
export { ArchiveTransport } from './archive-transport.js';
export type {
  ArchiveTransportConfig,
  ArchiveDelegatorConfig,
  ArchiveExecutorConfig,
  ArchiveWorkDirInfo,
  ChunkedArchiveInfo,
} from './types.js';
export { DEFAULT_DELEGATOR_CONFIG, DEFAULT_EXECUTOR_CONFIG } from './types.js';
```

---

### 4.10 `packages/sdk/src/listener/http-listener.ts`

**在现有路由后添加分块相关端点**：

找到 `async start(handler: ExecutorRequestHandler, callbacks?: ListenerCallbacks)` 方法，在现有路由定义后（`this.router.post('/cancel/:delegationId', ...)` 之后）添加：

```typescript
    // ========== Chunked Transfer Endpoints ==========

    // 接收单个分块
    this.router.post('/chunks/:delegationId', async (req, res) => {
      try {
        const { delegationId } = req.params;
        const { index, data, checksum } = req.body;

        if (typeof index !== 'number' || typeof data !== 'string' || typeof checksum !== 'string') {
          res.status(400).json({ error: 'Invalid chunk data' });
          return;
        }

        await handler.receiveChunk(delegationId, index, data, checksum);
        res.json({ ok: true, received: index });
      } catch (error) {
        console.error('[AWCP:HttpListener] Chunk receive error:', error);
        res.status(400).json({
          error: error instanceof Error ? error.message : 'Chunk receive failed',
        });
      }
    });

    // 查询分块状态（用于断点续传）
    this.router.get('/chunks/:delegationId/status', (req, res) => {
      try {
        const { delegationId } = req.params;
        const status = handler.getChunkStatus(delegationId);

        if (!status.exists) {
          res.status(404).json({ error: 'Chunk receiver not found' });
          return;
        }

        res.json({
          received: status.received,
          missing: status.missing,
          complete: status.complete,
        });
      } catch (error) {
        console.error('[AWCP:HttpListener] Chunk status error:', error);
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Internal error',
        });
      }
    });

    // 完成分块传输
    this.router.post('/chunks/:delegationId/complete', async (req, res) => {
      try {
        const { delegationId } = req.params;
        const { totalChecksum } = req.body;

        if (typeof totalChecksum !== 'string') {
          res.status(400).json({ error: 'Missing totalChecksum' });
          return;
        }

        await handler.completeChunks(delegationId, totalChecksum);
        res.json({ ok: true, assembled: true });
      } catch (error) {
        console.error('[AWCP:HttpListener] Chunk complete error:', error);
        res.status(400).json({
          error: error instanceof Error ? error.message : 'Chunk assembly failed',
        });
      }
    });
```

---

### 4.11 `packages/sdk/src/executor/service.ts`

**需要修改的部分**：

#### 4.11.1 新增 import

在文件顶部添加：

```typescript
import type { ChunkedArchiveInfo, ArchiveWorkDirInfo, ChunkStatusResponse } from '@awcp/core';
```

#### 4.11.2 新增成员变量

在 `private completedDelegations = new Map<...>()` 后添加：

```typescript
  // 等待分块完成的 Promise 解析器
  private chunkCompletionResolvers = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
```

#### 4.11.3 修改 `handleStart` 方法

**替换整个 `handleStart` 方法**：

```typescript
  private async handleStart(start: StartMessage): Promise<void> {
    const { delegationId } = start;

    const pending = this.pendingInvitations.get(delegationId);
    if (!pending) {
      console.warn(`[AWCP:Executor] Unknown delegation for START: ${delegationId}`);
      return;
    }

    const workPath = this.workspace.allocate(delegationId);
    this.pendingInvitations.delete(delegationId);

    const eventEmitter = new EventEmitter();

    this.activeDelegations.set(delegationId, {
      id: delegationId,
      workPath,
      task: pending.invite.task,
      lease: start.lease,
      environment: pending.invite.environment,
      startedAt: new Date(),
      eventEmitter,
    });

    // 检查是否为分块模式
    const workDirInfo = start.workDir as ArchiveWorkDirInfo;
    if (workDirInfo.transport === 'archive' && workDirInfo.chunked) {
      // 初始化分块接收器
      const archiveTransport = this.transport as import('@awcp/transport-archive').ArchiveTransport;
      archiveTransport.initChunkReceiver(delegationId, workDirInfo.chunked);

      console.log(`[AWCP:Executor] Waiting for chunked transfer: ${delegationId}`);

      // 等待分块传输完成
      try {
        await this.waitForChunks(delegationId);
        console.log(`[AWCP:Executor] Chunked transfer complete: ${delegationId}`);
      } catch (error) {
        console.error(`[AWCP:Executor] Chunked transfer failed: ${delegationId}`, error);
        
        const errorEvent: TaskErrorEvent = {
          delegationId,
          type: 'error',
          timestamp: new Date().toISOString(),
          code: ErrorCodes.TRANSPORT_FAILED,
          message: error instanceof Error ? error.message : 'Chunked transfer failed',
          hint: 'Check network connection and retry',
        };
        eventEmitter.emit('event', errorEvent);
        
        this.activeDelegations.delete(delegationId);
        await this.workspace.release(workPath);
        return;
      }
    }

    // Task execution runs async - don't await
    this.executeTask(delegationId, start, workPath, pending.invite.task, start.lease, pending.invite.environment, eventEmitter);
  }

  private waitForChunks(delegationId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.chunkCompletionResolvers.set(delegationId, { resolve, reject });

      // 超时处理
      const timeout = setTimeout(() => {
        if (this.chunkCompletionResolvers.has(delegationId)) {
          this.chunkCompletionResolvers.delete(delegationId);
          reject(new Error('Chunked transfer timeout'));
        }
      }, 5 * 60 * 1000); // 5 分钟超时

      // 存储 timeout 以便清理
      const resolver = this.chunkCompletionResolvers.get(delegationId)!;
      const originalResolve = resolver.resolve;
      resolver.resolve = () => {
        clearTimeout(timeout);
        originalResolve();
      };
    });
  }
```

#### 4.11.4 新增分块处理方法

在类的末尾（`private createErrorMessage` 方法之后）添加：

```typescript
  // ========== Chunked Transfer Methods ==========

  async receiveChunk(delegationId: string, index: number, data: string, checksum: string): Promise<void> {
    if (this.transport.type !== 'archive') {
      throw new Error('Chunked transfer only supported for archive transport');
    }

    const archiveTransport = this.transport as import('@awcp/transport-archive').ArchiveTransport;
    await archiveTransport.receiveChunk(delegationId, index, data, checksum);
  }

  async completeChunks(delegationId: string, totalChecksum: string): Promise<void> {
    if (this.transport.type !== 'archive') {
      throw new Error('Chunked transfer only supported for archive transport');
    }

    const archiveTransport = this.transport as import('@awcp/transport-archive').ArchiveTransport;
    await archiveTransport.completeChunks(delegationId, totalChecksum);

    // 触发等待的 Promise
    const resolver = this.chunkCompletionResolvers.get(delegationId);
    if (resolver) {
      this.chunkCompletionResolvers.delete(delegationId);
      resolver.resolve();
    }
  }

  getChunkStatus(delegationId: string): ChunkStatusResponse {
    if (this.transport.type !== 'archive') {
      return { exists: false, received: [], missing: [], complete: false };
    }

    const archiveTransport = this.transport as import('@awcp/transport-archive').ArchiveTransport;
    return archiveTransport.getChunkStatus(delegationId);
  }
```

#### 4.11.5 在 `@awcp/core` 中添加错误码

在 `packages/core/src/errors/codes.ts`（或对应位置）添加：

```typescript
export const ErrorCodes = {
  // ... 现有错误码 ...
  TRANSPORT_FAILED: 'TRANSPORT_FAILED',
} as const;
```

---

### 4.12 `packages/sdk/src/delegator/service.ts`

**修改 `handleAccept` 方法**：

找到 `await this.executorClient.sendStart(executorUrl, startMessage);` 这一行，在其后添加：

```typescript
    await this.executorClient.sendStart(executorUrl, startMessage);

    // === 分块上传 ===
    if (this.transport.type === 'archive') {
      const archiveTransport = this.transport as import('@awcp/transport-archive').ArchiveTransport;
      if (archiveTransport.isChunkedMode(delegation.id)) {
        console.log(`[AWCP:Delegator] Starting chunked upload for ${delegation.id}`);
        try {
          await archiveTransport.uploadChunks(delegation.id, executorUrl);
          console.log(`[AWCP:Delegator] Chunked upload complete for ${delegation.id}`);
        } catch (error) {
          console.error(`[AWCP:Delegator] Chunked upload failed for ${delegation.id}:`, error);
          await this.cleanup(delegation.id);
          throw error;
        }
      }
    }

    this.config.hooks.onDelegationStarted?.(updated);
```

---

## 5. 配置说明

### 5.1 Delegator 侧配置

```typescript
const transport = new ArchiveTransport({
  delegator: {
    tempDir: '/path/to/temp',      // 临时文件目录
    chunkThreshold: 10 * 1024 * 1024, // 10MB，超过此值启用分块
    chunkSize: 2 * 1024 * 1024,    // 2MB，单块大小
    uploadConcurrency: 3,          // 并发上传数，0=串行
    chunkRetries: 3,               // 单块重试次数
    chunkTimeout: 30000,           // 单块超时 30s
  },
});
```

### 5.2 Executor 侧配置

```typescript
const transport = new ArchiveTransport({
  executor: {
    tempDir: '/path/to/temp',      // 临时文件目录
    chunkReceiveTimeout: 5 * 60 * 1000, // 分块接收总超时 5 分钟
  },
});
```

### 5.3 默认值

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `chunkThreshold` | 10MB | 超过此值启用分块 |
| `chunkSize` | 2MB | 单块大小 |
| `uploadConcurrency` | 3 | 并发上传数，0 表示串行 |
| `chunkRetries` | 3 | 单块重试次数 |
| `chunkTimeout` | 30000ms | 单块上传超时 |
| `chunkReceiveTimeout` | 300000ms | Executor 接收总超时 |

---

## 6. 测试建议

### 6.1 单元测试

```typescript
// packages/transport-archive/test/chunk-receiver.test.ts
describe('ChunkReceiver', () => {
  it('should receive chunks in order');
  it('should receive chunks out of order');
  it('should reject invalid checksum');
  it('should reject duplicate chunk (idempotent)');
  it('should assemble complete file');
  it('should timeout on incomplete transfer');
});

// packages/transport-archive/test/chunk-uploader.test.ts
describe('ChunkUploader', () => {
  it('should upload all chunks serially');
  it('should upload chunks concurrently');
  it('should retry failed chunk');
  it('should skip already received chunks (resume)');
});

// packages/transport-archive/test/archive-transport.test.ts
describe('ArchiveTransport chunked mode', () => {
  it('should use inline mode for small files');
  it('should use chunked mode for large files');
  it('should complete roundtrip with chunked transfer');
});
```

### 6.2 集成测试场景

1. **小文件传输**：确保原有逻辑不受影响
2. **大文件传输**：验证分块流程
3. **断点续传**：模拟中断后恢复
4. **并发上传**：验证并发配置生效
5. **超时处理**：验证超时清理

---

## 7. 注意事项

1. **类型导入**：`ExecutorService` 中使用了动态 import 类型，如果 TypeScript 报错，可改为：
   ```typescript
   import type { ArchiveTransport } from '@awcp/transport-archive';
   ```
   并在文件顶部添加此 import。

2. **错误码**：确保 `TRANSPORT_FAILED` 已添加到 `ErrorCodes`。

3. **向后兼容**：新旧版本混用时，新 Delegator 发送 chunked 模式给旧 Executor 会失败，需统一升级。

4. **内存优化**：流式处理已应用于校验和计算和分块读取，但 base64 编码时单块仍需全部加载到内存（2MB 可接受）。

---

## 8. 后续优化方向（可选）

- [ ] 进度回调支持
- [ ] 压缩传输（gzip chunks）
- [ ] 更细粒度的超时控制
- [ ] 分块大小自适应（根据网络状况）
