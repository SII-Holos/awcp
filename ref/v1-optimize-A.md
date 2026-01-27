# AWCP v1 性能优化备忘：解决“远程挂载 + 本地工具”的读放大陷阱（Optimize-A）

> 目的：作为 AWCP/AWPS 的后续演进参考，给出一套**现实可落地**的方案，缓解 WAN 环境下 SSHFS/WebDAV 等“远程挂载式文件系统”在 **read-heavy 全库扫描/索引/构建** 场景的性能灾难。

## 1. 问题定义（Performance Trap）

当 Remote 通过“挂载目录”使用其本地工具链（grep/rg、git grep、LSP 索引、编译/测试等）时，工具会发起大量小 I/O（readdir/stat/open/read）。在 WAN 上，这会导致：

- **高延迟放大**：一次扫描触发成千上万次往返。
- **吞吐瓶颈**：目录遍历、读取大量小文件导致带宽与 RTT 双重限制。
- **资源抖动**：Host 侧网络/CPU 负载激增，影响本地用户。

结论：仅靠“远程文件系统抽象”无法高效支撑 read-heavy 工具。

## 2. 核心原则

1. **把计算移到数据旁（Host-side execution）**：扫描、索引、测试等尽量在 Host 本地完成，只回传结果。
2. **或把数据一次性搬到计算旁（Snapshot/Mirror）**：Remote 需要重工具时，用快照/增量同步替代细粒度挂载 I/O。
3. **挂载只用于局部编辑（Edit-light）**：把 mount 当作“编辑通道”而非“全库分析通道”。

本文聚焦于最具性价比的方向：**Host Side-channel Services（方案 A）**。

## 3. 方案 A：Host Side-channel Services（“重活”在 Host 跑）

### 3.1 服务集合（最小闭环）

建议从 3 个高价值服务开始：

1) **Search Service**（替代 `grep -r`/`rg`/`git grep`）
- `search(query, scope, options) -> matches`
- Host 端实现可基于 `ripgrep`（rg），回传：文件、行号、匹配片段、上下文、统计、分页 token。

2) **Exec Service（受控命令执行）**（替代 `npm test`/`pytest`/`go test` 等）
- `exec(argv, cwd_scope, env_allowlist, timeout, resource_quota) -> {stdout, stderr, exit_code, artifacts}`
- 强制路径白名单、资源配额、审计日志。

3) **Index/LSP Service（可选但收益极高）**
- Host 上运行 language server/索引器。
- Remote 仅做 LSP 前端（JSON-RPC 透传/代理）。

### 3.2 “工具不统一”怎么落地？——三层现实路径

> 目标不是对任意工具做 100% 透明拦截，而是用**可包装的入口点**覆盖 80% 痛点。

**Level 0：显式 RPC 调用（最简单）**
- Remote agent 被提示/策略约束：全库扫描必须调用 `awcp.search`，测试必须 `awcp.exec`。
- 适合：你能控制 Remote agent 提示词/策略的环境。

**Level 1：命令级 shim/wrapper（推荐性价比最高）**
- Remote daemon 在任务沙箱中把 `PATH` 前置到一个 `shim/` 目录。
- 在 `shim/` 中放置同名可执行文件（如 `rg`, `grep`, `git` 的子集），将命令转发到 Host 的服务。
- 这样对多数“通过 CLI 调用”的工具无需改造。

**Level 2：LSP Proxy（对写代码体验提升最大）**
- LSP 天然 client/server 架构：Remote 将 LSP 请求转发到 Host 的 language server。
- 避免 Remote 在挂载目录上做全量索引与 watch。

不推荐：跨平台系统调用拦截（LD_PRELOAD/驱动级 FS filter）——复杂度与不可预期行为过高。

## 4. 协议层建议：以能力协商为核心（不绑定具体工具）

由于不同 Remote/Agent 的工具体系差异巨大，协议不应规定“必须有 rg”，而应定义**稳定的服务接口**与**能力协商字段**。

### 4.1 建议扩展字段（可作为 v2 或 v1.1）

在 `ACCEPT.remote_constraints` 增加 capabilities：
```json
{
  "capabilities": {
    "sidechannel": {
      "search": true,
      "exec": true,
      "lsp_proxy": ["ts", "py", "go"],
      "max_output_bytes": 1048576
    },
    "shim": {
      "supports_path_prepend": true,
      "preferred_commands": ["rg", "git"]
    }
  }
}
```

在 `START` 增加 Host 服务端点与凭证（与 Lease TTL 绑定）：
```json
{
  "services": {
    "search": {
      "endpoint": "https://host-awcp.example/search",
      "token": "...",
      "scope": "workspace/"
    },
    "exec": {
      "endpoint": "https://host-awcp.example/exec",
      "token": "...",
      "scope": "workspace/",
      "policy": {"allow_network": false, "timeout_seconds": 600}
    },
    "lsp": {
      "endpoint": "wss://host-awcp.example/lsp",
      "token": "...",
      "languages": ["ts", "py"]
    }
  }
}
```

### 4.2 对应错误码建议
- `SERVICE_UNAVAILABLE`：Host 未启用对应 side-channel 服务。
- `POLICY_DENIED`：触发 Host/Remote 策略（例如 exec 禁止、路径越界）。
- `OUTPUT_TRUNCATED`：输出超限被截断（同时返回 `next_token` 供分页）。
- `TIMEOUT`：服务端执行超时。
- `QUOTA_EXCEEDED`：CPU/内存/磁盘/网络配额触顶。

## 5. 安全与审计（Exec/Search 的关键点）

### 5.1 Search Service
- 仅允许在 Export View 范围内搜索（scope path 白名单）。
- 对 query/options 做长度与复杂度限制（防止 ReDoS/超大输出）。
- 输出分页/截断，避免把大量内容通过 A2A 回传导致 DoS。

### 5.2 Exec Service
- 强制沙箱：容器/隔离用户、只允许 cwd 在 scope 内、可选禁网。
- 环境变量 allowlist，禁止泄露本机 secret。
- 资源配额：CPU/内存/IO/进程数/运行时间。
- 全量审计：argv、cwd、退出码、耗时、资源使用摘要。

## 6. 推荐组合策略（可写入规范的“行为建议”）

1. **默认挂载（sshfs/webdav）用于 edit-light**（小范围读写与文件修改）。
2. **显式禁止/劝阻在挂载上做 read-heavy**（全库 grep、LSP 初次索引、watch、构建）。
3. Remote daemon 若检测到高风险命令（如 `rg -uuu .`、`npm test`、LSP 初始化），优先：
   - 走 side-channel（search/exec/lsp），或
   - 提示用户/切换到 snapshot/mirror 模式（见 Optimize-B）。

## 7. 局限性

- shim 仅能覆盖“通过 CLI 调用”的工具；对直接用库遍历文件系统的程序无效。
- LSP proxy 需针对语言与编辑器集成；跨生态仍有工程成本。
- Exec service 本质是“远程执行”，必须把安全设计放在第一优先级。

---

## 参考
- RFC 4918 (WebDAV): https://www.rfc-editor.org/rfc/rfc4918
- RFC 5689 (Extended MKCOL): https://www.rfc-editor.org/rfc/rfc5689
