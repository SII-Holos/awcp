#!/bin/bash
#
# Run the 01-local-basic AWCP experiment
#
# This script starts both the Delegator Daemon and the Executor Agent,
# then triggers a delegation to modify workspace/hello.txt.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SCENARIO_DIR="$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         AWCP Local Basic Experiment                        ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check dependencies
echo -e "${YELLOW}Checking dependencies...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is required but not installed.${NC}"
    exit 1
fi

if ! command -v npx &> /dev/null; then
    echo -e "${RED}Error: npx is required but not installed.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Dependencies OK${NC}"
echo ""

# Build packages if needed
echo -e "${YELLOW}Building packages...${NC}"
cd "$SCRIPT_DIR/../../.."
npm run build -w @awcp/core && npm run build -w @awcp/transport-sshfs && npm run build -w @awcp/sdk
echo -e "${GREEN}✓ Build complete${NC}"
echo ""

# Return to scenario directory
cd "$SCRIPT_DIR"

# Create required directories
mkdir -p logs workdir exports

# Reset workspace
echo -e "${YELLOW}Resetting workspace...${NC}"
echo "Hello, World!" > workspace/hello.txt
echo -e "${GREEN}✓ Workspace reset${NC}"

# Cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}Cleaning up...${NC}"
    
    # Kill background processes
    if [ -n "$DELEGATOR_PID" ]; then
        kill $DELEGATOR_PID 2>/dev/null || true
    fi
    if [ -n "$EXECUTOR_PID" ]; then
        kill $EXECUTOR_PID 2>/dev/null || true
    fi
    
    # Cleanup workdir
    ./cleanup.sh 2>/dev/null || true
    
    echo -e "${GREEN}✓ Cleanup complete${NC}"
}

trap cleanup EXIT

# Start Delegator Daemon
echo ""
echo -e "${BLUE}Starting Delegator Daemon on :3100...${NC}"
npx tsx start-delegator.ts > logs/delegator.log 2>&1 &
DELEGATOR_PID=$!
sleep 2

# Check if delegator started
if ! kill -0 $DELEGATOR_PID 2>/dev/null; then
    echo -e "${RED}Error: Delegator failed to start. Check logs/delegator.log${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Delegator Daemon started (PID: $DELEGATOR_PID)${NC}"

# Start Executor Agent
echo ""
echo -e "${BLUE}Starting Executor Agent on :4001...${NC}"
cd "$SCRIPT_DIR/../../shared/executor-agent"
npx tsx src/agent.ts > "$SCRIPT_DIR/logs/executor.log" 2>&1 &
EXECUTOR_PID=$!
cd "$SCRIPT_DIR"
sleep 2

# Check if executor started
if ! kill -0 $EXECUTOR_PID 2>/dev/null; then
    echo -e "${RED}Error: Executor failed to start. Check logs/executor.log${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Executor Agent started (PID: $EXECUTOR_PID)${NC}"

# Show workspace before
echo ""
echo -e "${BLUE}Workspace before delegation:${NC}"
echo "----------------------------------------"
cat workspace/hello.txt
echo "----------------------------------------"
echo ""

# Trigger delegation
echo -e "${BLUE}Triggering delegation...${NC}"
echo ""
npx tsx trigger.ts

# Show workspace after
echo ""
echo -e "${BLUE}Workspace after delegation:${NC}"
echo "----------------------------------------"
cat workspace/hello.txt
echo "----------------------------------------"
echo ""

echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Experiment Complete!                               ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Logs available in:"
echo "  - logs/delegator.log"
echo "  - logs/executor.log"
echo ""
