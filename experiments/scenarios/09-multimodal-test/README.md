# 09-multimodal-test

Test AWCP chunked transport with large multimodal workspaces containing images for AI analysis.

## What This Tests

This experiment validates two key capabilities:

1. **Chunked file transfer** — Large workspaces (~6MB, 100 images) are split into 512KB chunks and uploaded in parallel
2. **Multimodal delegation** — The executor analyzes images, categorizes them by content, and generates a report

The chunked transport kicks in automatically when workspace size exceeds 2MB (lowered from production defaults for testing).

## Prerequisites

**Required:**
- OpenClaw CLI installed globally: `npm install -g openclaw@latest`
- Valid API key exported: `export SII_API_KEY="your-api-key"`

**Optional:**
- Model selection: `export SII_MODEL="sonnet"` (default: sonnet)

## Directory Structure

```
09-multimodal-test/
├── run.sh              # Main entry point
├── trigger.ts          # Delegation trigger script
├── cleanup.sh          # Cleanup script
├── package.json
├── workspace/          # Test data (images to analyze)
├── test_data/          # Original test data backup
├── logs/               # Executor and daemon logs
├── temp/               # Temporary files during transfer
├── exports/            # Delegator exports
└── workdir/            # Executor work directory
```

## Running the Experiment

```bash
# 1. Set your API credentials
export SII_API_KEY="your-api-key"
export SII_MODEL="sonnet"  # optional

# 2. Run the experiment
./run.sh
```

The script handles everything: starting services, creating the delegation, and displaying results.

## What Happens

1. **Executor starts** on port 10200 (OpenClaw agent)
2. **Delegator daemon starts** on port 3100
3. **Delegation created** with a multimodal task:
   - Analyze all images in the workspace
   - Organize them by content category
   - Generate an analysis report
4. **Chunked upload** transfers the ~6MB workspace in parallel chunks
5. **Executor processes** the task and returns results
6. **Results displayed** with final delegation state

## Expected Output

During chunked upload:
```
[AWCP:Delegator] Starting chunked upload (6.2MB, 13 chunks)
[AWCP:Delegator] Completed chunked upload
```

SSE event stream:
```
event: status
event: snapshot
event: done
```

Final state should be `completed`. If the AI generates a report, look for `workspace/analysis_report.md`.

## Chunked Transport Configuration

| Setting | Value | Notes |
|---------|-------|-------|
| Threshold | 2MB | Lowered for testing (production: higher) |
| Chunk size | 512KB | Balance between overhead and parallelism |
| Concurrency | 3 | Parallel chunk uploads |
| Test data | ~6MB | 100 images across categories |

## Troubleshooting

**Timeout errors**
Check `logs/executor.log` for details. The AI may need more time for image analysis—consider increasing the task timeout.

**ENOENT errors**
Usually indicates a temp directory collision. This should be fixed in recent versions. If it persists, run `./cleanup.sh` and retry.

**No images found**
Ensure `workspace/` contains the test images. If empty, copy from `test_data/`:
```bash
cp -r test_data/* workspace/
```

**API errors**
Verify your `SII_API_KEY` is valid and has sufficient quota.

## Related Documentation

- [Chunked Transport Technical Design](/docs/chunked-transport.md)
- [AWCP Protocol Specification](/docs/v1.md)
