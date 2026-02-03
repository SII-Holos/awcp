#!/bin/bash
#
# Run the 07-storage-transport AWCP experiment
#
# Tests Storage transport: URL-based file transfer using pre-signed URLs.
# Uses local filesystem storage provider for testing (simulates S3).
#
# Flow:
#   MCP Client (trigger.ts)
#       | stdio (JSON-RPC)
#   awcp-mcp server (auto-starts Delegator Daemon with Storage transport)
#       | INVITE/START + SSE events
#   OpenClaw Executor (:10201) with Storage transport
#       | Uses storage transport (pre-signed URLs)
#   Local Storage Server (:3200)
#
# Prerequisites:
#   - OpenClaw installed: npm install -g openclaw@latest
#   - API key: DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OPENCLAW_EXECUTOR_DIR="$ROOT_DIR/examples/openclaw-executor"
export SCENARIO_DIR="$SCRIPT_DIR"

# Port configuration (use different ports to avoid conflicts with other running executors)
EXECUTOR_PORT="${EXECUTOR_PORT:-10201}"
STORAGE_PORT="${STORAGE_PORT:-3200}"
OPENCLAW_PORT="${OPENCLAW_PORT:-18790}"

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

# Check dependencies
echo -e "${YELLOW}Checking dependencies...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is required but not installed.${NC}"
    exit 1
fi

if ! command -v openclaw &> /dev/null; then
    echo -e "${RED}Error: OpenClaw not found. Install with:${NC}"
    echo "   npm install -g openclaw@latest"
    exit 1
fi
echo -e "${GREEN}✓ OpenClaw found: $(openclaw --version 2>/dev/null || echo 'installed')${NC}"

# Check for API keys
if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ] && [ -z "$OPENROUTER_API_KEY" ] && [ -z "$DEEPSEEK_API_KEY" ]; then
    echo -e "${YELLOW}Warning: No AI API key found. Set one of:${NC}"
    echo "   - DEEPSEEK_API_KEY"
    echo "   - ANTHROPIC_API_KEY"
    echo "   - OPENAI_API_KEY"
    echo "   - OPENROUTER_API_KEY"
    echo ""
fi

echo -e "${GREEN}✓ Dependencies OK${NC}"
echo ""

# Build
echo -e "${YELLOW}Building packages...${NC}"
cd "$ROOT_DIR"
npm run build > /dev/null 2>&1
echo -e "${GREEN}✓ Build complete${NC}"
echo ""

cd "$SCRIPT_DIR"

# Create directories
mkdir -p logs workdir exports temp workspace storage

# Reset workspace
echo -e "${YELLOW}Resetting workspace...${NC}"
cat > workspace/README.md << 'EOF'
# Storage Transport Test Project

This project tests the AWCP Storage Transport with pre-signed URLs.
EOF
echo "Hello from Storage Transport test!" > workspace/hello.txt
echo -e "${GREEN}✓ Workspace reset${NC}"

# Cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}Cleaning up...${NC}"
    [ -n "$STORAGE_SERVER_PID" ] && kill $STORAGE_SERVER_PID 2>/dev/null || true
    [ -n "$EXECUTOR_PID" ] && kill $EXECUTOR_PID 2>/dev/null || true
    ./cleanup.sh 2>/dev/null || true
    echo -e "${GREEN}✓ Cleanup complete${NC}"
}

trap cleanup EXIT

# Start local storage server (simulates S3 pre-signed URLs)
echo ""
echo -e "${BLUE}Starting Local Storage Server on :${STORAGE_PORT}...${NC}"
npx tsx storage-server.ts > logs/storage-server.log 2>&1 &
STORAGE_SERVER_PID=$!
sleep 2

if ! kill -0 $STORAGE_SERVER_PID 2>/dev/null; then
    echo -e "${RED}Error: Storage server failed to start. Check logs/storage-server.log${NC}"
    cat logs/storage-server.log
    exit 1
fi
echo -e "${GREEN}✓ Storage server started (PID: $STORAGE_SERVER_PID)${NC}"

# Start OpenClaw Executor with Storage transport
echo ""
echo -e "${BLUE}Starting OpenClaw Executor with Storage transport on :${EXECUTOR_PORT}...${NC}"
cd "$OPENCLAW_EXECUTOR_DIR"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    npm install > /dev/null 2>&1
fi

PORT=$EXECUTOR_PORT \
OPENCLAW_PORT=$OPENCLAW_PORT \
SCENARIO_DIR="$SCRIPT_DIR" \
AWCP_TRANSPORT=storage \
npx tsx src/agent.ts > "$SCRIPT_DIR/logs/executor.log" 2>&1 &
EXECUTOR_PID=$!

cd "$SCRIPT_DIR"

# Wait for Executor to be ready
echo -e "${YELLOW}Waiting for OpenClaw Gateway and Executor to start...${NC}"
for i in {1..60}; do
    if curl -s http://localhost:$EXECUTOR_PORT/health 2>/dev/null | grep -q '"status"'; then
        echo -e "${GREEN}✓ OpenClaw Executor started (PID: $EXECUTOR_PID)${NC}"
        break
    fi
    if [ $i -eq 60 ]; then
        echo -e "${RED}Error: Executor failed to start. Check logs/executor.log${NC}"
        cat logs/executor.log 2>/dev/null | tail -30
        exit 1
    fi
    sleep 1
done

# Export storage config for MCP server
export AWCP_STORAGE_LOCAL_DIR="$SCRIPT_DIR/storage"
export AWCP_STORAGE_ENDPOINT="http://localhost:$STORAGE_PORT"
export EXECUTOR_URL="http://localhost:$EXECUTOR_PORT/awcp"
export EXECUTOR_BASE_URL="http://localhost:$EXECUTOR_PORT"

# Show workspace before
echo ""
echo -e "${BLUE}Workspace before delegation:${NC}"
echo "----------------------------------------"
cat workspace/hello.txt
echo "----------------------------------------"

# Trigger delegation
echo ""
echo -e "${BLUE}Running MCP integration test with Storage transport...${NC}"
echo -e "${YELLOW}(MCP server will auto-start Delegator Daemon with Storage transport)${NC}"
echo ""
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
echo "  - logs/executor.log"
echo "  - logs/daemon.log"
echo ""

exit $TEST_EXIT_CODE
