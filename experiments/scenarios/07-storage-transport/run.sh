#!/bin/bash
#
# Run the 07-storage-transport AWCP experiment
#
# Tests Storage transport: URL-based file transfer using pre-signed URLs.
# Uses local filesystem storage provider for testing (simulates S3).
#
# Flow:
#   trigger.ts (DelegatorDaemonClient)
#       |
#   Delegator Daemon (Storage transport + LocalStorageProvider)
#       | INVITE/START + SSE events
#   Shared Executor Agent with AWCP_TRANSPORT=storage
#       | Uses storage transport (pre-signed URLs)
#   Local Storage Server (:3200)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
export SCENARIO_DIR="$SCRIPT_DIR"

# Port configuration
DELEGATOR_PORT="${DELEGATOR_PORT:-3100}"
EXECUTOR_PORT="${EXECUTOR_PORT:-4001}"
STORAGE_PORT="${STORAGE_PORT:-3200}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     AWCP Storage Transport Experiment                      ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "This test uses URL-based storage transfer (simulates S3/cloud storage)."
echo "A local file server simulates pre-signed URL functionality."
echo ""

# Build
echo -e "${YELLOW}Building packages...${NC}"
cd "$ROOT_DIR"
npx tsx node_modules/typescript/lib/tsc.js -b packages/core packages/transport-archive packages/transport-storage packages/sdk
echo -e "${GREEN}✓ Build complete${NC}"
echo ""

cd "$SCRIPT_DIR"

# Create directories
mkdir -p logs workdir exports temp workspace storage

# Reset workspace
echo -e "${YELLOW}Resetting workspace...${NC}"
echo "Hello from Storage Transport test!" > workspace/hello.txt
echo -e "${GREEN}✓ Workspace reset${NC}"

# Cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}Cleaning up...${NC}"
    [ -n "$STORAGE_SERVER_PID" ] && kill $STORAGE_SERVER_PID 2>/dev/null || true
    [ -n "$DELEGATOR_PID" ] && kill $DELEGATOR_PID 2>/dev/null || true
    [ -n "$EXECUTOR_PID" ] && kill $EXECUTOR_PID 2>/dev/null || true
    rm -rf workdir/* exports/* temp/* storage/* 2>/dev/null || true
    echo -e "${GREEN}✓ Cleanup complete${NC}"
}

trap cleanup EXIT

# Start local storage server (simulates S3 pre-signed URLs)
echo ""
echo -e "${BLUE}Starting Local Storage Server on :${STORAGE_PORT}...${NC}"
STORAGE_PORT=$STORAGE_PORT npx tsx storage-server.ts > logs/storage-server.log 2>&1 &
STORAGE_SERVER_PID=$!
sleep 2

if ! kill -0 $STORAGE_SERVER_PID 2>/dev/null; then
    echo -e "${RED}Error: Storage server failed to start. Check logs/storage-server.log${NC}"
    cat logs/storage-server.log
    exit 1
fi
echo -e "${GREEN}✓ Storage server started (PID: $STORAGE_SERVER_PID)${NC}"

# Start Delegator (with Storage transport)
echo ""
echo -e "${BLUE}Starting Delegator Daemon (Storage transport)...${NC}"
export AWCP_STORAGE_LOCAL_DIR="$SCRIPT_DIR/storage"
export AWCP_STORAGE_ENDPOINT="http://localhost:$STORAGE_PORT"
DELEGATOR_PORT=$DELEGATOR_PORT npx tsx start-delegator.ts > logs/delegator.log 2>&1 &
DELEGATOR_PID=$!
sleep 2

if ! kill -0 $DELEGATOR_PID 2>/dev/null; then
    echo -e "${RED}Error: Delegator failed to start. Check logs/delegator.log${NC}"
    cat logs/delegator.log
    exit 1
fi
echo -e "${GREEN}✓ Delegator started (PID: $DELEGATOR_PID)${NC}"

# Start Executor (with Storage transport via AWCP_TRANSPORT env)
echo ""
echo -e "${BLUE}Starting Executor Agent (Storage transport)...${NC}"
cd "$SCRIPT_DIR/../../shared/executor-agent"
PORT=$EXECUTOR_PORT AWCP_TRANSPORT=storage SCENARIO_DIR="$SCRIPT_DIR" npx tsx src/agent.ts > "$SCRIPT_DIR/logs/executor.log" 2>&1 &
EXECUTOR_PID=$!
cd "$SCRIPT_DIR"
sleep 2

if ! kill -0 $EXECUTOR_PID 2>/dev/null; then
    echo -e "${RED}Error: Executor failed to start. Check logs/executor.log${NC}"
    cat logs/executor.log
    exit 1
fi
echo -e "${GREEN}✓ Executor started (PID: $EXECUTOR_PID)${NC}"

# Show workspace before
echo ""
echo -e "${BLUE}Workspace before delegation:${NC}"
echo "----------------------------------------"
cat workspace/hello.txt
echo "----------------------------------------"

# Trigger delegation
echo ""
echo -e "${BLUE}Triggering delegation...${NC}"
DELEGATOR_URL="http://localhost:$DELEGATOR_PORT" \
EXECUTOR_URL="http://localhost:$EXECUTOR_PORT/awcp" \
npx tsx trigger.ts
TEST_EXIT_CODE=$?

# Show workspace after
echo ""
echo -e "${BLUE}Workspace after delegation:${NC}"
echo "----------------------------------------"
cat workspace/hello.txt
echo "----------------------------------------"
echo ""

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║     Storage Transport Experiment Complete!                 ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
else
    echo -e "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║     Storage Transport Experiment Failed                    ║${NC}"
    echo -e "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
fi

echo ""
echo "The file was transferred via pre-signed URLs (simulating S3)!"
echo ""
echo "Logs:"
echo "  - logs/storage-server.log"
echo "  - logs/delegator.log"
echo "  - logs/executor.log"
echo ""

exit $TEST_EXIT_CODE
