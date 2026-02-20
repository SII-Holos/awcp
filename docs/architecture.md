# AWCP 系统架构图

## 1. 整体系统架构

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              AWCP System Overview                                    │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  ┌─────────────────────────┐                    ┌─────────────────────────┐         │
│  │      Delegator Side     │                    │      Executor Side      │         │
│  │   (Workspace Owner)     │                    │    (Task Performer)     │         │
│  ├─────────────────────────┤                    ├─────────────────────────┤         │
│  │                         │                    │                         │         │
│  │  ┌───────────────────┐  │    Control Plane   │  ┌───────────────────┐  │         │
│  │  │   Claude Desktop  │  │  ═══════════════>  │  │   AI Agent        │  │         │
│  │  │   (MCP Client)    │  │  INVITE/START/SSE  │  │   (A2A/Custom)    │  │         │
│  │  └─────────┬─────────┘  │                    │  └─────────┬─────────┘  │         │
│  │            │ stdio      │                    │            │            │         │
│  │  ┌─────────▼─────────┐  │                    │  ┌─────────▼─────────┐  │         │
│  │  │    @awcp/mcp      │  │                    │  │   ExecutorService │  │         │
│  │  │   MCP Server      │  │                    │  │   (HTTP Handler)  │  │         │
│  │  └─────────┬─────────┘  │                    │  └─────────┬─────────┘  │         │
│  │            │ HTTP       │                    │            │            │         │
│  │  ┌─────────▼─────────┐  │                    │  ┌─────────▼─────────┐  │         │
│  │  │ Delegator Daemon  │  │     Data Plane     │  │ TransportAdapter  │  │         │
│  │  │ (DelegatorService)│  │  ───────────────>  │  │ (setup/detach)    │  │         │
│  │  └─────────┬─────────┘  │  SSHFS/Archive/    │  └─────────┬─────────┘  │         │
│  │            │            │  Storage/Git       │            │            │         │
│  │  ┌─────────▼─────────┐  │                    │  ┌─────────▼─────────┐  │         │
│  │  │ TransportAdapter  │  │                    │  │  Work Directory   │  │         │
│  │  │ (prepare/release) │  │                    │  │  /awcp/workspaces │  │         │
│  │  └─────────┬─────────┘  │                    │  └───────────────────┘  │         │
│  │            │            │                    │                         │         │
│  │  ┌─────────▼─────────┐  │                    │                         │         │
│  │  │ Environment Dir   │  │                    │                         │         │
│  │  │ ~/.awcp/envs      │  │                    │                         │         │
│  │  └───────────────────┘  │                    │                         │         │
│  │            │            │                    │                         │         │
│  │  ┌─────────▼─────────┐  │                    │                         │         │
│  │  │  Local Workspace  │◄─┼────────────────────┼─────────────────────────┤         │
│  │  │  /path/to/project │  │   Result Applied   │   (SSHFS: real-time)    │         │
│  │  └───────────────────┘  │  (Archive/Storage) │                         │         │
│  │                         │                    │                         │         │
│  └─────────────────────────┘                    └─────────────────────────┘         │
│                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. 包依赖关系图

```
                                 ┌──────────────────────┐
                                 │      @awcp/mcp       │
                                 │    (MCP Server)      │
                                 │                      │
                                 │  • delegate          │
                                 │  • delegate_output   │
                                 │  • delegate_cancel   │
                                 │  • delegate_snapshots│
                                 │  • delegate_apply_   │
                                 │    snapshot          │
                                 │  • delegate_discard_ │
                                 │    snapshot          │
                                 │  • delegate_recover  │
                                 └──────────┬───────────┘
                                          │
                                          │ depends on
                                          ▼
                                 ┌──────────────────┐
                                 │    @awcp/sdk     │
                                 │                  │
                 ┌───────────────┤  Delegator:      │───────────────┐
                 │               │  • Service       │               │
                 │               │  • Daemon        │               │
                 │               │  • Admission     │               │
                 │               │  • Environment   │               │
                 │               │  • SnapshotMgr   │               │
                 │               │  • DelegationMgr │               │
                 │               │  • ResourceReg   │               │
                 │               │                  │               │
                 │               │  Executor:       │               │
                 │               │  • Service       │               │
                 │               │  • A2AAdapter    │               │
                 │               │  • WorkspaceMgr  │               │
                 │               │  • AssignmentMgr │               │
                 │               │  • Admission     │               │
                 │               │                  │               │
                 │               │  Listeners:      │               │
                 │               │  • HTTP          │               │
                 │               │  • WebSocket     │               │
                 │               └────────┬─────────┘               │
                 │                        │                         │
    ┌────────────┴────────────┐          │          ┌──────────────┴───────────┐
    │                         │          ▼          │                          │
    ▼                         ▼                     ▼                          ▼
┌────────────────┐  ┌────────────────┐  ┌──────────────────┐  ┌────────────────────┐
│ @awcp/transport│  │ @awcp/transport│  │   @awcp/core     │  │ @awcp/transport-   │
│     -sshfs     │  │     -git       │  │                  │  │     archive        │
│                │  │                │  │  Types:          │  │                    │
│• CredentialMgr │  │• GitTransport  │  │  • Messages      │  │  • createArchive   │
│• SshfsMountCli │  │• git-utils     │──│  • Transport     │──│  • extractArchive  │
│                │  │                │  │  • Snapshot      │  │  • applyResult     │
└────────────────┘  └───────┬────────┘  │  • Assignment    │  └─────────┬──────────┘
        │                  │            │  • Service       │            │
        │                  │            │                  │            │ reuses utils
        │                  │ reuses     │  Utilities:      │            ▼
        │                  │ utils      │  • generateId    │  ┌────────────────────┐
        │                  └───────────►│                  │  │ @awcp/transport-   │
        └──────────────────────────────►│                  │  │     storage        │
                                        │  Errors:         │  │                    │
                                        │  • AwcpError     │  │                    │
                                        │  • 15 subclasses │  │  • StorageProvider │
                                        │                  │  │  • LocalStorage    │
                                        │  State Machine:  │  │  • S3Storage       │
                                        │  • DelegationSM  │  └────────────────────┘
                                        │    (9 states)    │
                                        │  • AssignmentSM  │
                                        │    (4 states)    │
                                        │                  │
                                        │  Zero deps!      │
                                        └──────────────────┘
```

## 3. 协议消息流程

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                             AWCP Protocol Message Flow                                     │
├───────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                            │
│   Delegator                                                              Executor          │
│       │                                                                      │             │
│       │  ┌──────────────────────────────────────────────────────────────┐   │             │
│       │  │ 1. INVITE                                                    │   │             │
│       │  │    • task: { description, prompt }                           │   │             │
│       │  │    • lease: { ttlSeconds, accessMode }                       │   │             │
│       │  │    • environment: { resources: ResourceDeclaration[] }       │   │             │
│       │  │    • requirements?: { transport }                            │   │             │
│       │  │    • auth?: { type, credential }                             │   │             │
│       │  │    • retentionMs?: number                                    │   │             │
│       │  └──────────────────────────────────────────────────────────────┘   │             │
│       │ ──────────────────────── POST / ───────────────────────────────────►│             │
│       │                                                                      │             │
│       │                                          ┌───────────────────────────┤             │
│       │                                          │ Policy Check:             │             │
│       │                                          │ • maxConcurrent?          │             │
│       │                                          │ • maxTtlSeconds?          │             │
│       │                                          │ • transport supported?    │             │
│       │                                          │ • autoAccept or hook?     │             │
│       │                                          └───────────────────────────┤             │
│       │                                                                      │             │
│       │  ┌──────────────────────────────────────────────────────────────┐   │             │
│       │  │ 2. ACCEPT (or ERROR)                                         │   │             │
│       │  │    • executorWorkDir: { path }                               │   │             │
│       │  │    • executorConstraints?: {                                 │   │             │
│       │  │        acceptedAccessMode, maxTtlSeconds, sandboxProfile     │   │             │
│       │  │      }                                                       │   │             │
│       │  │    • retentionMs?: number                                    │   │             │
│       │  └──────────────────────────────────────────────────────────────┘   │             │
│       │ ◄────────────────────── HTTP Response ──────────────────────────────│             │
│       │                                                                      │             │
│ ┌─────┤                                                                      │             │
│ │     │ Prepare Transport:                                                   │             │
│ │     │ • SSHFS: generate SSH keys + certificates                            │             │
│ │     │ • Archive: create ZIP + base64 encode                                │             │
│ │     │ • Storage: upload ZIP to S3, get pre-signed URLs                     │             │
│ │     │ • Git: init repo, create base branch                                 │             │
│ └─────┤                                                                      │             │
│       │                                                                      │             │
│       │  ┌──────────────────────────────────────────────────────────────┐   │             │
│       │  │ 3. START                                                     │   │             │
│       │  │    • lease: { expiresAt, accessMode }                        │   │             │
│       │  │    • transportHandle: TransportHandle (transport-specific)    │   │             │
│       │  │      ├─ sshfs: endpoint + exportLocator + credential         │   │             │
│       │  │      ├─ archive: workspaceBase64 + checksum                  │   │             │
│       │  │      ├─ storage: downloadUrl + uploadUrl + checksum          │   │             │
│       │  │      └─ git: repoUrl + baseBranch + baseCommit + auth?       │   │             │
│       │  └──────────────────────────────────────────────────────────────┘   │             │
│       │ ──────────────────────── POST / ───────────────────────────────────►│             │
│       │ ◄────────────────────── { ok: true } ───────────────────────────────│             │
│       │                                                                      │             │
│       │                                          ┌───────────────────────────┤             │
│       │                                          │ Setup Workspace:          │             │
│       │                                          │ • SSHFS: mount remote     │             │
│       │                                          │ • Archive: decode+extract │             │
│       │                                          │ • Storage: download+unzip │             │
│       │                                          │ • Git: clone to commit    │             │
│       │                                          └───────────────────────────┤             │
│       │                                                                      │             │
│       │  ┌──────────────────────────────────────────────────────────────┐   │             │
│       │  │ 4. SSE Event Stream (4 event types)                          │   │             │
│       │  └──────────────────────────────────────────────────────────────┘   │             │
│       │ ───────────── GET /tasks/:taskId/events ─────────────────────────────►│             │
│       │                                                                      │             │
│       │ ◄─────── SSE: { type: "status", status: "running" } ────────────────│             │
│       │                                                                      │             │
│       │                                          ┌───────────────────────────┤             │
│       │                                          │ Execute Task:             │             │
│       │                                          │ TaskExecutor.execute()    │             │
│       │                                          │ • read/write workspace    │             │
│       │                                          │ • run commands            │             │
│       │                                          └───────────────────────────┤             │
│       │                                                                      │             │
│       │                                          ┌───────────────────────────┤             │
│       │                                          │ Teardown (creates snapshot│             │
│       │                                          │ for non-liveSync):        │             │
│       │                                          │ • Archive: ZIP → Base64   │             │
│       │                                          │ • Storage: upload to URL  │             │
│       │                                          │ • Git: commit + push      │             │
│       │                                          │ • SSHFS: unmount (no snap)│             │
│       │                                          └───────────────────────────┤             │
│       │                                                                      │             │
│       │ ◄─── SSE: { type: "snapshot", snapshotId, snapshotBase64,  ─────────│             │
│       │             summary, highlights?, recommended?, metadata? }          │             │
│       │                                                                      │             │
│       │ ◄─── SSE: { type: "done", summary, highlights?,  ───────────────────│             │
│       │             snapshotIds?, recommendedSnapshotId? }                   │             │
│       │                                                                      │             │
│ ┌─────┤ (stream closes)                                                      │             │
│ │     │                                                                      │             │
│ │     │ Apply Snapshot (based on policy):                                    │             │
│ │     │ • auto: decode + extract + copy to source dirs immediately           │             │
│ │     │ • staged: save to disk, await user applySnapshot() call              │             │
│ │     │ • discard: ignore snapshot data                                      │             │
│ │     │ • SSHFS: N/A (already synced via live mount)                         │             │
│ └─────┤                                                                      │             │
│       │                                                                      │             │
│       │  ┌──────────────────────────────────────────────────────────────┐   │             │
│       │  │ 5. Acknowledge (optional, for cleanup)                       │   │             │
│       │  └──────────────────────────────────────────────────────────────┘   │             │
│       │ ───────────── POST /tasks/:taskId/ack ────────────────────────────────►│             │
│       │ ◄────────────────────── { ok: true } ───────────────────────────────│             │
│       │                                                                      │             │
│       ▼                                                                      ▼             │
│                                                                                            │
├───────────────────────────────────────────────────────────────────────────────────────────┤
│  Alternative Flows:                                                                        │
│                                                                                            │
│  ERROR Response (at INVITE):                                                               │
│    ◄─── { type: "ERROR", code, message, hint? }                                           │
│                                                                                            │
│  SSE Error Event (during execution):                                                       │
│    ◄─── SSE: { type: "error", code, message, hint? }  (terminal, closes stream)           │
│                                                                                            │
│  Cancel (anytime before completion):                                                       │
│    ─── POST /cancel/:delegationId ──►  ◄─── { ok: true, cancelled: true }                 │
│                                                                                            │
│  Result Query (for recovery/polling):                                                      │
│    ─── GET /tasks/:taskId/result ──►  ◄─── { status, summary?, snapshotBase64?, error? }  │
│                                                                                            │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

## 4. 状态机

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                           Delegation State Machine                                    │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                       │
│                                    SEND_INVITE                                        │
│      ┌─────────┐ ──────────────────────────────────────► ┌─────────┐                 │
│      │ created │                                          │ invited │                 │
│      └────┬────┘                                          └────┬────┘                 │
│           │                                                    │                      │
│           │ CANCEL/ERROR                          RECEIVE_ACCEPT│                     │
│           │                                                    │                      │
│           │                                                    ▼                      │
│           │                                              ┌──────────┐                 │
│           │                                              │ accepted │                 │
│           │                                              └────┬─────┘                 │
│           │                                                   │                       │
│           │                                          SEND_START│                      │
│           │                                                   │                       │
│           │                                                   ▼                       │
│           │                                              ┌─────────┐                  │
│           │                                              │ started │                  │
│           │                                              └────┬────┘                  │
│           │                                                   │                       │
│           │                                      SETUP_COMPLETE│                      │
│           │                                                   │                       │
│           │                                                   ▼                       │
│           │                                              ┌─────────┐    RECEIVE_DONE  │
│           │                                              │ running │ ───────────────► │
│           │                                              └────┬────┘                  │
│           │                                                   │                       │
│           │                                                   │                       │
│           ▼                                                   ▼                       │
│     ┌───────────────────────────────────────────────────────────────────────────┐    │
│     │                          Terminal States                                   │    │
│     │  ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐            │    │
│     │  │ completed │   │   error   │   │ cancelled │   │  expired  │            │    │
│     │  │     ✓     │   │     ✗     │   │     ✗     │   │     ✗     │            │    │
│     │  └───────────┘   └───────────┘   └───────────┘   └───────────┘            │    │
│     └───────────────────────────────────────────────────────────────────────────┘    │
│                                                                                       │
│  Transition Events:                                                                   │
│  ┌────────────────────────────────────────────────────────────────────────────────┐  │
│  │ SEND_INVITE    : created → invited                                             │  │
│  │ RECEIVE_ACCEPT : invited → accepted                                            │  │
│  │ SEND_START     : accepted → started                                            │  │
│  │ SETUP_COMPLETE : started → running                                             │  │
│  │ RECEIVE_DONE   : running → completed                                           │  │
│  │ RECEIVE_ERROR  : any non-terminal → error                                      │  │
│  │ CANCEL         : any non-terminal → cancelled                                  │  │
│  │ EXPIRE         : invited/accepted/running → expired  (TODO: auto-timer)        │  │
│  └────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────────┐
│                         Assignment State Machine (Executor 侧)                        │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                       │
│                                                                                       │
│      ┌─────────┐  RECEIVE_START   ┌─────────┐  TASK_COMPLETE  ┌───────────┐          │
│      │ pending │ ────────────────► │  active │ ──────────────► │ completed │          │
│      └────┬────┘                   └────┬────┘                 └───────────┘          │
│           │                             │                                             │
│           │ RECEIVE_ERROR               │ TASK_FAIL                                   │
│           │ CANCEL                      │ CANCEL                                      │
│           │                             │                                             │
│           ▼                             ▼                                             │
│      ┌──────────────────────────────────────┐                                        │
│      │               error                  │                                        │
│      └──────────────────────────────────────┘                                        │
│                                                                                       │
│  Transition Events:                                                                   │
│  ┌────────────────────────────────────────────────────────────────────────────────┐  │
│  │ RECEIVE_START  : pending → active                                              │  │
│  │ TASK_COMPLETE  : active → completed                                            │  │
│  │ TASK_FAIL      : active → error                                                │  │
│  │ RECEIVE_ERROR  : pending → error                                               │  │
│  │ CANCEL         : pending/active → error                                        │  │
│  └────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 5. @awcp/sdk 内部组件

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                              @awcp/sdk Components                                     │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                       │
│  ┌────────────────────────────────────┐    ┌────────────────────────────────────┐   │
│  │         Delegator Side             │    │          Executor Side             │   │
│  ├────────────────────────────────────┤    ├────────────────────────────────────┤   │
│  │                                    │    │                                    │   │
│  │  ┌──────────────────────────────┐  │    │  ┌──────────────────────────────┐  │   │
│  │  │      DelegatorService        │  │    │  │      ExecutorService         │  │   │
│  │  │  ┌────────────────────────┐  │  │    │  │  ┌────────────────────────┐  │  │   │
│  │  │  │ • delegations Map      │  │  │    │  │  │ • assignments Map      │  │  │   │
│  │  │  │ • stateMachines Map    │  │  │    │  │  │ • stateMachines Map    │  │  │   │
│  │  │  │ • executorUrls Map     │  │  │    │  │  │ • eventEmitters Map    │  │  │   │
│  │  │  └────────────────────────┘  │  │    │  │  └────────────────────────┘  │  │   │
│  │  │                              │  │    │  │                              │  │   │
│  │  │  initialize()               │  │    │  │  initialize()               │  │   │
│  │  │  shutdown()                  │  │    │  │  shutdown()                  │  │   │
│  │  │  delegate()                  │  │    │  │  handleMessage()             │  │   │
│  │  │  handleAccept()              │  │    │  │  subscribeTask()             │  │   │
│  │  │  handleDone()                │  │    │  │  getTaskResult()             │  │   │
│  │  │  handleSnapshot()            │  │    │  │  acknowledgeResult()         │  │   │
│  │  │  handleError()               │  │    │  │  cancelDelegation()          │  │   │
│  │  │  listSnapshots()             │  │    │  │                              │  │   │
│  │  │  applySnapshot()             │  │    │  │                              │  │   │
│  │  │  cancel()                    │  │    │  │                              │  │   │
│  │  │  waitForCompletion()         │  │    │  │                              │  │   │
│  │  └──────────────────────────────┘  │    │  └──────────────────────────────┘  │   │
│  │         │         │         │      │    │       │       │       │       │    │   │
│  │         │         │         │      │    │       │       │       │       │    │   │
│  │         ▼         ▼         ▼      │    │       ▼       ▼       ▼       ▼    │   │
│  │  ┌──────────┐┌──────────┐┌──────────┐┌──────────┐│┌──────────┐┌──────────┐┌──────────┐┌──────────┐│
│  │  │Admission ││Environmt ││ Snapshot ││Delegation││││Workspace ││  Task    ││Assignmnt ││Admission ││
│  │  │Controller││ Manager  ││ Manager  ││ Manager  ││││ Manager  ││ Executor ││ Manager  ││Controller││
│  │  ├──────────┤├──────────┤├──────────┤├──────────┤│├──────────┤├──────────┤├──────────┤├──────────┤│
│  │  │check()   ││build()   ││receive() ││save()    ││││allocate()││execute() ││save()    ││check()   ││
│  │  │• size    ││release() ││apply()   ││loadAll() ││││prepare() ││          ││loadAll() ││•concurrnt││
│  │  │• count   ││cleanStale││discard() ││delete()  ││││release() ││Injected: ││delete()  ││• TTL     ││
│  │  │• single  ││          ││cleanDlg()││          ││││cleanStale││ • A2A    ││          ││• access  ││
│  │  │•sensitive││uses:     ││          ││          ││││          ││ • Custom ││          ││•transport││
│  │  │          ││ResourceRg││          ││          ││││          ││          ││          ││          ││
│  │  └──────────┘└──────────┘└──────────┘└──────────┘│└──────────┘└──────────┘└──────────┘└──────────┘│
│  │                                    │    │                                    │   │
│  │           │                        │    │                                    │   │
│  │           ▼                        │    │                                    │   │
│  │  ┌──────────────────────────────┐  │    │                                    │   │
│  │  │      ExecutorClient          │  │    │                                    │   │
│  │  ├──────────────────────────────┤  │    │                                    │   │
│  │  │ sendInvite()    POST /awcp   │──┼────┼──────────────────────────────────► │   │
│  │  │ sendStart()     POST /awcp   │──┼────┼──────────────────────────────────► │   │
│  │  │ subscribeTask() GET  /events │──┼────┼──────────────────────────────────► │   │
│  │  │ fetchResult()   GET  /result │──┼────┼──────────────────────────────────► │   │
│  │  │ acknowledgeResult() POST/ack │──┼────┼──────────────────────────────────► │   │
│  │  │ sendCancel()    POST /cancel │──┼────┼──────────────────────────────────► │   │
│  │  └──────────────────────────────┘  │    │                                    │   │
│  │                                    │    │                                    │   │
│  └────────────────────────────────────┘    └────────────────────────────────────┘   │
│                                                                                       │
│  ┌────────────────────────────────────────────────────────────────────────────────┐  │
│  │                              Listeners                                          │  │
│  ├────────────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                                 │  │
│  │  ┌─────────────────────────┐          ┌─────────────────────────────────────┐  │  │
│  │  │      HttpListener       │          │    WebSocketTunnelListener          │  │  │
│  │  ├─────────────────────────┤          ├─────────────────────────────────────┤  │  │
│  │  │ • Express Router        │          │ • Connects to tunnel server         │  │  │
│  │  │ • POST / (messages)     │          │ • NAT traversal support             │  │  │
│  │  │ • GET /tasks/:id/events │          │ • Reconnect with backoff            │  │  │
│  │  │ • GET /tasks/:id/result │          │ • Bidirectional HTTP over WS        │  │  │
│  │  │ • POST /tasks/:id/ack   │          │ • SSE tunneling                     │  │  │
│  │  │ • POST /cancel/:id      │          │                                     │  │  │
│  │  │ • Direct HTTP access    │          │                                     │  │  │
│  │  └─────────────────────────┘          └─────────────────────────────────────┘  │  │
│  │                                                                                 │  │
│  └────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 6. Transport 对比

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                           Transport Comparison                                        │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              SSHFS Transport                                     │ │
│  ├─────────────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                                  │ │
│  │   Delegator                                              Executor               │ │
│  │   ┌──────────────┐                                      ┌──────────────┐        │ │
│  │   │ Credential   │ ──── SSH Certificate ────────────►   │ SshfsMount   │        │ │
│  │   │ Manager      │      (ED25519 + CA-signed)           │ Client       │        │ │
│  │   └──────────────┘                                      └──────┬───────┘        │ │
│  │         │                                                      │                │ │
│  │         │                        ┌─────────────────────────────┘                │ │
│  │         │                        │ FUSE Mount                                   │ │
│  │         ▼                        ▼                                              │ │
│  │   ┌──────────────┐          ┌──────────────┐                                    │ │
│  │   │ Export Dir   │ ◄═══════►│ Work Dir     │   Real-time bidirectional sync    │ │
│  │   │ (source)     │   SSHFS  │ (mounted)    │                                    │ │
│  │   └──────────────┘          └──────────────┘                                    │ │
│  │                                                                                  │ │
│  │   ✓ Real-time sync    ✓ Large workspaces    ✗ Requires SSHFS    ✗ SSH access   │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                             Archive Transport                                    │ │
│  ├─────────────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                                  │ │
│  │   Delegator                                              Executor               │ │
│  │   ┌──────────────┐                                      ┌──────────────┐        │ │
│  │   │ Source Dir   │                                      │ Work Dir     │        │ │
│  │   └──────┬───────┘                                      └──────▲───────┘        │ │
│  │          │ ZIP                                                 │ extract        │ │
│  │          ▼                                                     │                │ │
│  │   ┌──────────────┐    START message (inline)            ┌──────┴───────┐        │ │
│  │   │ Base64 ZIP   │ ─────────────────────────────────►   │ Base64 ZIP   │        │ │
│  │   └──────────────┘    workspaceBase64 + checksum        └──────────────┘        │ │
│  │                                                                                  │ │
│  │   ┌──────────────┐    DONE event (inline)               ┌──────────────┐        │ │
│  │   │ Apply Result │ ◄─────────────────────────────────   │ ZIP Result   │        │ │
│  │   └──────────────┘    resultBase64                      └──────────────┘        │ │
│  │                                                                                  │ │
│  │   ✓ Zero deps        ✓ Simple setup      ✗ Full copy 2x    ✗ Memory heavy      │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                             Storage Transport                                    │ │
│  ├─────────────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                                  │ │
│  │   Delegator              Storage (S3/HTTP)               Executor               │ │
│  │   ┌──────────────┐      ┌──────────────┐                ┌──────────────┐        │ │
│  │   │ Source Dir   │      │              │                │ Work Dir     │        │ │
│  │   └──────┬───────┘      │   ┌──────┐   │                └──────▲───────┘        │ │
│  │          │ upload       │   │ ZIP  │   │   download            │                │ │
│  │          └──────────►   │   │ File │   │   ◄───────────────────┘                │ │
│  │                         │   └──────┘   │                                        │ │
│  │   ┌──────────────┐      │              │                ┌──────────────┐        │ │
│  │   │ START msg    │ ─────│─ URLs only ──│──────────────► │ Fetch via    │        │ │
│  │   │ downloadUrl  │      │ (lightweight)│                │ pre-signed   │        │ │
│  │   │ uploadUrl    │      │              │                │ URL          │        │ │
│  │   └──────────────┘      └──────────────┘                └──────────────┘        │ │
│  │                                                                                  │ │
│  │   ✓ Large workspaces  ✓ Cloud-native    ✗ External storage   ✗ URL expiry      │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              Git Transport                                       │ │
│  ├─────────────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                                  │ │
│  │   Delegator                 Git Server                   Executor               │ │
│  │   ┌──────────────┐         ┌──────────────┐            ┌──────────────┐        │ │
│  │   │ Source Dir   │         │   Remote     │            │ Work Dir     │        │ │
│  │   └──────┬───────┘         │   Repo       │            └──────▲───────┘        │ │
│  │          │ git init +      │              │                   │ git clone      │ │
│  │          │ push            │ ┌──────────┐ │   git clone       │                │ │
│  │          └──────────────►  │ │  main    │ │   ──────────────► │                │ │
│  │                            │ │ branch   │ │                   │                │ │
│  │                            │ └──────────┘ │                   │                │ │
│  │                            │ ┌──────────┐ │   git push        │                │ │
│  │   ┌──────────────┐         │ │ awcp/    │ │   ◄─────────────  │                │ │
│  │   │ git fetch +  │ ◄───────│ │ {dlgId}  │ │                   │                │ │
│  │   │ merge        │         │ │ branch   │ │                   │                │ │
│  │   └──────────────┘         │ └──────────┘ │                   │                │ │
│  │                            └──────────────┘                                    │ │
│  │                                                                                  │ │
│  │   ✓ Version history  ✓ Diff tracking  ✓ Branch mgmt  ✗ No live sync           │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 7. @awcp/mcp 与 Claude Desktop 集成

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                          MCP Integration with Claude Desktop                          │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                       │
│                               claude_desktop_config.json                              │
│   ┌─────────────────────────────────────────────────────────────────────────────┐    │
│   │ {                                                                            │    │
│   │   "mcpServers": {                                                            │    │
│   │     "awcp": {                                                                │    │
│   │       "command": "npx",                                                      │    │
│   │       "args": ["@awcp/mcp", "--peers", "http://executor:10200"]             │    │
│   │     }                                                                        │    │
│   │   }                                                                          │    │
│   │ }                                                                            │    │
│   └─────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                       │
│   ┌─────────────────────────────────────────────────────────────────────────────┐    │
│   │                             Startup Sequence                                 │    │
│   │                                                                              │    │
│   │   1. Claude Desktop launches awcp-mcp via npx                               │    │
│   │                  │                                                           │    │
│   │                  ▼                                                           │    │
│   │   2. Parse CLI args (--peers, --transport, --port, etc.)                    │    │
│   │                  │                                                           │    │
│   │                  ▼                                                           │    │
│   │   3. Peer Discovery ──► Fetch Agent Cards from --peers URLs                 │    │
│   │                  │      ┌────────────────────────────────────┐              │    │
│   │                  │      │ GET /.well-known/agent-card.json   │              │    │
│   │                  │      │ → { name, skills, description }    │              │    │
│   │                  │      └────────────────────────────────────┘              │    │
│   │                  ▼                                                           │    │
│   │   4. Auto-start Delegator Daemon (if not running)                           │    │
│   │                  │      ┌────────────────────────────────────┐              │    │
│   │                  │      │ startDelegatorDaemon()             │              │    │
│   │                  │      │ • Creates DelegatorService         │              │    │
│   │                  │      │ • Starts HTTP server on :3100      │              │    │
│   │                  │      └────────────────────────────────────┘              │    │
│   │                  ▼                                                           │    │
│   │   5. Create MCP Server with tools                                           │    │
│   │                  │      ┌────────────────────────────────────┐              │    │
│   │                  │      │ Tools:                             │              │    │
│   │                  │      │ • delegate (inject peer context)   │              │    │
│   │                  │      │ • delegate_output                  │              │    │
│   │                  │      │ • delegate_cancel                  │              │    │
│   │                  │      │ • delegate_snapshots               │              │    │
│   │                  │      │ • delegate_apply_snapshot           │              │    │
│   │                  │      │ • delegate_discard_snapshot         │              │    │
│   │                  │      │ • delegate_recover                  │              │    │
│   │                  │      └────────────────────────────────────┘              │    │
│   │                  ▼                                                           │    │
│   │   6. Connect via StdioServerTransport                                       │    │
│   │                  │                                                           │    │
│   │                  ▼                                                           │    │
│   │   7. Ready to receive tool calls from Claude                                │    │
│   │                                                                              │    │
│   └─────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                       │
│   ┌─────────────────────────────────────────────────────────────────────────────┐    │
│   │                             Runtime Flow                                     │    │
│   │                                                                              │    │
│   │   Claude Desktop                                                             │    │
│   │        │                                                                     │    │
│   │        │  User: "Delegate ./src to another agent for code review"           │    │
│   │        │                                                                     │    │
│   │        ▼                                                                     │    │
│   │   ┌─────────┐  stdio   ┌─────────┐  HTTP   ┌─────────┐  AWCP   ┌─────────┐  │    │
│   │   │ Claude  │ ───────► │ awcp-   │ ──────► │Delegator│ ──────► │Executor │  │    │
│   │   │ (LLM)   │ tool     │ mcp     │ REST    │ Daemon  │ proto   │ Agent   │  │    │
│   │   └─────────┘ call     └─────────┘         └─────────┘         └─────────┘  │    │
│   │        │                    │                   │                    │       │    │
│   │        │                    │                   │                    │       │    │
│   │   delegate({               POST               INVITE              handle     │    │
│   │     workspace_dir,      /delegate            ────────►           message    │    │
│   │     peer_url,              │                   │                    │       │    │
│   │     prompt                 │                 ACCEPT              setup      │    │
│   │   })                       │                 ◄────────           workspace  │    │
│   │        │                   │                   │                    │       │    │
│   │        │                   │                 START               execute    │    │
│   │        │                   │                ────────►             task      │    │
│   │        │                   │                   │                    │       │    │
│   │        │                   │                  SSE                  done     │    │
│   │        │                   │                ◄────────               │       │    │
│   │        ◄───────────────────┴───────────────────┴────────────────────┘       │    │
│   │   Result: { summary, highlights }                                            │    │
│   │                                                                              │    │
│   └─────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 8. 关键抽象接口

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                            Key Abstraction Interfaces                                 │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                          TransportAdapter                                        │ │
│  │  (defined in @awcp/core, implemented by transport packages)                      │ │
│  ├─────────────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                                  │ │
│  │  TransportCapabilities {                                                         │ │
│  │    supportsSnapshots: boolean   // Can return snapshot data                      │ │
│  │    liveSync: boolean            // Real-time sync (SSHFS only)                   │ │
│  │  }                                                                               │ │
│  │                                                                                  │ │
│  │  DelegatorTransportAdapter              ExecutorTransportAdapter                │ │
│  │  ┌──────────────────────────┐          ┌──────────────────────────┐             │ │
│  │  │ type: TransportType      │          │ type: TransportType      │             │ │
│  │  │ capabilities: {...}      │          │ capabilities: {...}      │             │ │
│  │  │                          │          │                          │             │ │
│  │  │ initialize?(workDir)     │          │ initialize?(workDir)     │             │ │
│  │  │  → void                  │          │  → void                  │             │ │
│  │  │                          │          │                          │             │ │
│  │  │ shutdown?()              │          │ shutdown?()              │             │ │
│  │  │  → void                  │          │  → void                  │             │ │
│  │  │                          │          │                          │             │ │
│  │  │ prepare(params)          │          │ checkDependency()        │             │ │
│  │  │  → TransportHandle       │          │  → { available, hint }   │             │ │
│  │  │                          │          │                          │             │ │
│  │  │ applySnapshot?(params)   │          │ setup(params)            │             │ │
│  │  │  → void                  │          │  → workPath              │             │ │
│  │  │                          │          │                          │             │ │
│  │  │ detach(delegationId)     │          │ captureSnapshot?(params) │             │ │
│  │  │  → void                  │          │  → { snapshotBase64? }   │             │ │
│  │  │                          │          │                          │             │ │
│  │  │ release(delegationId)    │          │ detach(params)           │             │ │
│  │  │  → void                  │          │  → void                  │             │ │
│  │  │                          │          │                          │             │ │
│  │  │                          │          │ release(params)          │             │ │
│  │  │                          │          │  → void                  │             │ │
│  │  └──────────────────────────┘          └──────────────────────────┘             │ │
│  │                                                                                  │ │
│  │  Implementations:                                                                │ │
│  │    SshfsDelegatorTransport, SshfsExecutorTransport,                              │ │
│  │    ArchiveDelegatorTransport, ArchiveExecutorTransport,                          │ │
│  │    StorageDelegatorTransport, StorageExecutorTransport,                          │ │
│  │    GitDelegatorTransport, GitExecutorTransport                                   │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                            TaskExecutor                                          │ │
│  │  (defined in @awcp/core, injected into ExecutorService)                          │ │
│  ├─────────────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                                  │ │
│  │  ┌─────────────────────────────────────────────────────────────────────────┐    │ │
│  │  │ execute(context: TaskExecutionContext): Promise<TaskExecutionResult>    │    │ │
│  │  │                                                                         │    │ │
│  │  │ TaskExecutionContext {          TaskExecutionResult {                   │    │ │
│  │  │   delegationId: string            summary: string                       │    │ │
│  │  │   workPath: string                highlights?: string[]                 │    │ │
│  │  │   task: TaskSpec                }                                       │    │ │
│  │  │   environment: EnvironmentDeclaration                                     │    │ │
│  │  │ }                                                                       │    │ │
│  │  └─────────────────────────────────────────────────────────────────────────┘    │ │
│  │                                                                                  │ │
│  │  Implementations: A2ATaskExecutor (wraps A2A AgentExecutor), Custom             │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                           ListenerAdapter                                        │ │
│  │  (defined in @awcp/core, implemented by SDK listener classes)                    │ │
│  ├─────────────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                                  │ │
│  │  ┌─────────────────────────────────────────────────────────────────────────┐    │ │
│  │  │ type: string                                                            │    │ │
│  │  │                                                                         │    │ │
│  │  │ start(handler, callbacks): Promise<ListenerInfo | null>                 │    │ │
│  │  │                                                                         │    │ │
│  │  │ stop(): Promise<void>                                                   │    │ │
│  │  │                                                                         │    │ │
│  │  │ ListenerInfo { type: string, publicUrl: string }                        │    │ │
│  │  └─────────────────────────────────────────────────────────────────────────┘    │ │
│  │                                                                                  │ │
│  │  Implementations: HttpListener, WebSocketTunnelListener                         │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                          ResourceAdapter                                         │ │
│  │  (defined in @awcp/sdk, extensible for new resource types)                       │ │
│  ├─────────────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                                  │ │
│  │  ┌─────────────────────────────────────────────────────────────────────────┐    │ │
│  │  │ type: string  (e.g., 'fs', 'git', 's3')                                 │    │ │
│  │  │                                                                         │    │ │
│  │  │ materialize(spec, targetPath): Promise<void>                            │    │ │
│  │  │   // Create resource in environment directory                           │    │ │
│  │  │                                                                         │    │ │
│  │  │ apply(sourcePath, targetPath): Promise<void>                            │    │ │
│  │  │   // Write back changes (for rw mode)                                   │    │ │
│  │  └─────────────────────────────────────────────────────────────────────────┘    │ │
│  │                                                                                  │ │
│  │  Implementations: FsResourceAdapter (symlink/copy)                              │ │
│  │  Planned: GitResourceAdapter, S3ResourceAdapter                                 │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 9. 错误体系

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                              Error Class Hierarchy                                    │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                       │
│                                   ┌─────────────┐                                    │
│                                   │    Error    │  (JavaScript built-in)             │
│                                   └──────┬──────┘                                    │
│                                          │                                           │
│                                          ▼                                           │
│                                   ┌─────────────┐                                    │
│                                   │  AwcpError  │  Base class                        │
│                                   │             │  • code: string                    │
│                                   │             │  • message: string                 │
│                                   │             │  • hint?: string                   │
│                                   │             │  • delegationId?: string           │
│                                   └──────┬──────┘                                    │
│                                          │                                           │
│         ┌────────────────────────────────┼────────────────────────────────┐          │
│         │                                │                                │          │
│         ▼                                ▼                                ▼          │
│  ┌──────────────┐              ┌──────────────┐              ┌──────────────┐        │
│  │  Workspace   │              │  Transport   │              │   Protocol   │        │
│  │   Errors     │              │   Errors     │              │    Errors    │        │
│  └──────┬───────┘              └──────┬───────┘              └──────┬───────┘        │
│         │                             │                             │                │
│         ▼                             ▼                             ▼                │
│  ┌────────────────┐           ┌────────────────┐           ┌────────────────┐        │
│  │TooLarge        │           │SetupFailed     │           │Declined        │        │
│  │• stats: {      │           │                │           │                │        │
│  │   bytes,       │           ├────────────────┤           ├────────────────┤        │
│  │   fileCount,   │           │TransportError  │           │AuthFailed      │        │
│  │   largestFile  │           │                │           │                │        │
│  │  }             │           ├────────────────┤           ├────────────────┤        │
│  ├────────────────┤           │ChecksumMismatch│           │TaskFailed      │        │
│  │NotFound        │           │• expected      │           │                │        │
│  │• path          │           │• actual        │           ├────────────────┤        │
│  ├────────────────┤           │                │           │LeaseExpired    │        │
│  │Invalid         │           ├────────────────┤           │                │        │
│  │• path          │           │DepMissing      │           ├────────────────┤        │
│  │• reason        │           │• dependency    │           │Cancelled       │        │
│  ├────────────────┤           │                │           │                │        │
│  │WorkDirDenied   │           │                │           │                │        │
│  │                │           │                │           │                │        │
│  ├────────────────┤           │                │           │                │        │
│  │SensitiveFiles  │           │                │           │                │        │
│  │• files: string[]│          │                │           │                │        │
│  └────────────────┘           └────────────────┘           └────────────────┘        │
│                                                                                       │
│  Error Codes (15 total):                                                             │
│  ┌────────────────────────────────────────────────────────────────────────────────┐  │
│  │ WORKSPACE_TOO_LARGE  WORKSPACE_NOT_FOUND  WORKSPACE_INVALID  WORKDIR_DENIED    │  │
│  │ SENSITIVE_FILES       SETUP_FAILED         TRANSPORT_ERROR    CHECKSUM_MISMATCH │  │
│  │ DEP_MISSING           DECLINED             AUTH_FAILED        TASK_FAILED       │  │
│  │ CANCELLED             START_EXPIRED        EXPIRED                              │  │
│  └────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 10. 完整数据流

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                          Complete Data Flow (Archive Example)                         │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                       │
│  User → Claude: "Review the code in ./my-project"                                    │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              1. Tool Invocation                                  │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│     Claude Desktop                                                                    │
│         │ stdio                                                                       │
│         ▼                                                                             │
│     awcp-mcp ──► delegate({                                                          │
│         │           workspace_dir: "./my-project",                                   │
│         │           peer_url: "http://executor:10200/awcp",                          │
│         │           prompt: "Review the code..."                                     │
│         │        })                                                                  │
│         │                                                                             │
│         │ HTTP POST /delegate                                                        │
│         ▼                                                                             │
│     Delegator Daemon                                                                  │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                            2. Admission Check                                    │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│     AdmissionController.check("./my-project")                                        │
│         │                                                                             │
│         ├── Scan files (skip node_modules, .git)                                     │
│         ├── Count: 150 files, 2.5MB total, largest 100KB                             │
│         └── ✓ Within limits → allowed: true                                          │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                          3. Environment Building                                 │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│     EnvironmentManager.build(delegationId, environment)                              │
│         │                                                                             │
│         ├── Create: ~/.awcp/envs/{delegationId}/                                     │
│         ├── Symlink: workspace → ./my-project                                        │
│         └── Write: .awcp/manifest.json                                               │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                            4. Protocol Exchange                                  │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│     ExecutorClient.sendInvite()                                                       │
│         │                                                                             │
│         │  POST http://executor:10200/awcp                                           │
│         │  { type: "INVITE", task, lease, environment }                              │
│         │                                                                             │
│         ▼                                                                             │
│     Executor: handleInvite()                                                          │
│         │                                                                             │
│         ├── Policy check: maxConcurrent=5, current=2 ✓                               │
│         ├── Transport check: archive supported ✓                                     │
│         └── Allocate workDir: /awcp/workspaces/{delegationId}                        │
│         │                                                                             │
│         │  Response: { type: "ACCEPT", executorWorkDir, constraints }                │
│         ▼                                                                             │
│     Delegator: handleAccept()                                                         │
│         │                                                                             │
│         ├── State: invited → accepted                                                │
│         │                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                          5. Transport Preparation                                │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│         └── ArchiveDelegatorTransport.prepare()                                      │
│                 │                                                                     │
│                 ├── ZIP: ~/.awcp/envs/{id}/ → /tmp/awcp/{id}.zip                     │
│                 ├── Checksum: SHA-256 → "a1b2c3..."                                  │
│                 └── Encode: base64(zip) → "UEsDBBQ..."                               │
│                                                                                       │
│     ExecutorClient.sendStart()                                                        │
│         │                                                                             │
│         │  POST http://executor:10200/awcp                                           │
│         │  { type: "START", lease, transportHandle: {                                │
│         │      transport: "archive",                                                 │
│         │      workspaceBase64: "UEsDBBQ...",                                        │
│         │      checksum: "a1b2c3..."                                                 │
│         │  }}                                                                        │
│         │                                                                             │
│         ▼                                                                             │
│     Executor: handleStart()                                                           │
│         │  Response: { ok: true }                                                    │
│         │                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                           6. Workspace Setup                                     │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│         └── ArchiveExecutorTransport.setup()                                         │
│                 │                                                                     │
│                 ├── Decode: base64 → /tmp/workspace.zip                              │
│                 ├── Verify: SHA-256 checksum ✓                                       │
│                 └── Extract: → /awcp/workspaces/{id}/                                │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                           7. Task Execution                                      │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│     Executor: executeTask()                                                           │
│         │                                                                             │
│         ├── SSE: { type: "status", status: "running" }                               │
│         │                                                                             │
│         └── TaskExecutor.execute({                                                   │
│                 delegationId,                                                         │
│                 workPath: "/awcp/workspaces/{id}/workspace",                          │
│                 task: { description, prompt },                                        │
│                 environment                                                           │
│             })                                                                        │
│                 │                                                                     │
│                 ├── AI Agent reads files                                             │
│                 ├── AI Agent analyzes code                                           │
│                 ├── AI Agent writes review comments                                  │
│                 └── Returns: { summary: "Found 3 issues...", highlights: [...] }     │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              8. Result Return                                    │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│         └── ArchiveExecutorTransport.captureSnapshot() + detach()                    │
│                 │                                                                     │
│                 ├── ZIP: /awcp/workspaces/{id}/ → result.zip                         │
│                 └── Encode: base64 → resultBase64                                    │
│                                                                                       │
│         SSE: { type: "done", summary, highlights, resultBase64 }                      │
│              │                                                                        │
│              ▼                                                                        │
│     Delegator: handleTaskEvent() → handleDone()                                       │
│         │                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                            9. Result Application                                 │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│         └── ArchiveDelegatorTransport.applySnapshot()                                │
│                 │                                                                     │
│                 ├── Decode: base64 → /tmp/result.zip                                 │
│                 ├── Extract: → /tmp/result/                                          │
│                 └── Copy: /tmp/result/workspace/* → ./my-project/ (rw only)          │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              10. Cleanup                                         │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│     Delegator:                              Executor:                                 │
│         │                                       │                                    │
│         ├── Delete temp archives                ├── Delete workDir                   │
│         ├── Release environment                 └── Remove from active               │
│         └── State: running → completed                                               │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │                            11. Return to User                                    │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│     awcp-mcp → Claude Desktop                                                         │
│         │                                                                             │
│         └── { summary: "Found 3 issues...", highlights: ["src/api.ts"] }             │
│                                                                                       │
│     Claude → User: "I delegated the code review. The agent found 3 issues:..."       │
│                                                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```
