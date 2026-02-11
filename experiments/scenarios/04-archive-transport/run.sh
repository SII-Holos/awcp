#!/bin/bash
#
# Run the 04-archive-transport AWCP experiment
#
# Tests Archive transport: HTTP-based file transfer (no SSHFS required)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SCENARIO_DIR="$SCRIPT_DIR"
export AWCP_TRANSPORT="archive"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     AWCP Archive Transport Experiment                      ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "This test uses HTTP-based archive transfer instead of SSHFS."
echo "No SSH keys or SSHFS installation required!"
echo ""

# Build
echo -e "${YELLOW}Building packages...${NC}"
cd "$SCRIPT_DIR/../../.."
npx tsx node_modules/typescript/lib/tsc.js -b packages/core packages/transport-archive packages/sdk
echo -e "${GREEN}✓ Build complete${NC}"
echo ""

cd "$SCRIPT_DIR"

# Create directories
mkdir -p logs workdir exports temp workspace

# Reset workspace
echo -e "${YELLOW}Resetting workspace...${NC}"
echo "Hello from Archive Transport test!" > workspace/hello.txt
echo -e "${GREEN}✓ Workspace reset${NC}"

# Cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}Cleaning up...${NC}"
    [ -n "$DELEGATOR_PID" ] && kill $DELEGATOR_PID 2>/dev/null || true
    [ -n "$EXECUTOR_PID" ] && kill $EXECUTOR_PID 2>/dev/null || true
    rm -rf workdir/* exports/* temp/* 2>/dev/null || true
    echo -e "${GREEN}✓ Cleanup complete${NC}"
}

trap cleanup EXIT

# Start Delegator (with Archive transport)
echo ""
echo -e "${BLUE}Starting Delegator Daemon (Archive transport)...${NC}"
npx tsx start-delegator.ts > logs/delegator.log 2>&1 &
DELEGATOR_PID=$!
sleep 2

if ! kill -0 $DELEGATOR_PID 2>/dev/null; then
    echo -e "${RED}Error: Delegator failed to start. Check logs/delegator.log${NC}"
    cat logs/delegator.log
    exit 1
fi
echo -e "${GREEN}✓ Delegator started (PID: $DELEGATOR_PID)${NC}"

# Start Executor (with Archive transport via AWCP_TRANSPORT env)
echo ""
echo -e "${BLUE}Starting Executor Agent (Archive transport)...${NC}"
cd "$SCRIPT_DIR/../../shared/executor-agent"
AWCP_TRANSPORT=archive SCENARIO_DIR="$SCRIPT_DIR" npx tsx src/agent.ts > "$SCRIPT_DIR/logs/executor.log" 2>&1 &
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
npx tsx trigger.ts

# Show workspace after
echo ""
echo -e "${BLUE}Workspace after delegation:${NC}"
echo "----------------------------------------"
cat workspace/hello.txt
echo "----------------------------------------"
echo ""

echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     Archive Transport Experiment Complete!                 ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "The file was transferred via HTTP (ZIP download/upload), not SSHFS!"
echo ""
echo "Logs:"
echo "  - logs/delegator.log"
echo "  - logs/executor.log"
echo ""
