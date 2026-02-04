#!/bin/bash
#
# Run the 08-git-transport AWCP experiment
#
# Tests Git transport: Uses Git repositories for workspace transfer.
# Creates a local bare repository to simulate a remote Git server.
#
# Flow:
#   MCP Client (trigger.ts)
#       | stdio (JSON-RPC)
#   awcp-mcp server (auto-starts Delegator Daemon with Git transport)
#       | INVITE/START + SSE events
#   OpenClaw Executor (:10202) with Git transport
#       | Uses git clone/push for file transfer
#   Local bare Git repo (./git-server/repo.git)
#
# Prerequisites:
#   - Git installed
#   - OpenClaw installed: npm install -g openclaw@latest
#   - API key: DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OPENCLAW_EXECUTOR_DIR="$ROOT_DIR/examples/openclaw-executor"
export SCENARIO_DIR="$SCRIPT_DIR"

# Port configuration (use different ports to avoid conflicts)
EXECUTOR_PORT="${EXECUTOR_PORT:-10202}"
OPENCLAW_PORT="${OPENCLAW_PORT:-18791}"

# Git server configuration (local bare repo)
GIT_SERVER_DIR="$SCRIPT_DIR/git-server"
GIT_REPO_PATH="$GIT_SERVER_DIR/repo.git"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     AWCP Git Transport Experiment                          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "This test uses Git for workspace transfer."
echo "A local bare Git repository simulates a remote server."
echo ""

# Check dependencies
echo -e "${YELLOW}Checking dependencies...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is required but not installed.${NC}"
    exit 1
fi

if ! command -v git &> /dev/null; then
    echo -e "${RED}Error: Git is required but not installed.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Git found: $(git --version)${NC}"

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
mkdir -p logs workdir temp workspace git-server

# Setup local bare Git repository
echo -e "${YELLOW}Setting up local Git server (bare repo)...${NC}"
rm -rf "$GIT_REPO_PATH"
git init --bare "$GIT_REPO_PATH" > /dev/null 2>&1
echo -e "${GREEN}✓ Bare repository created at: $GIT_REPO_PATH${NC}"

# Reset workspace
echo -e "${YELLOW}Resetting workspace...${NC}"
cat > workspace/README.md << 'EOF'
# Git Transport Test Project

This project tests the AWCP Git Transport.
File transfer is done via Git clone and push.
EOF
echo "Hello from Git Transport test!" > workspace/hello.txt
echo -e "${GREEN}✓ Workspace reset${NC}"

# Cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}Cleaning up...${NC}"
    [ -n "$EXECUTOR_PID" ] && kill $EXECUTOR_PID 2>/dev/null || true
    ./cleanup.sh 2>/dev/null || true
    echo -e "${GREEN}✓ Cleanup complete${NC}"
}

trap cleanup EXIT

# Start OpenClaw Executor with Git transport
echo ""
echo -e "${BLUE}Starting OpenClaw Executor with Git transport on :${EXECUTOR_PORT}...${NC}"
cd "$OPENCLAW_EXECUTOR_DIR"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    npm install > /dev/null 2>&1
fi

PORT=$EXECUTOR_PORT \
OPENCLAW_PORT=$OPENCLAW_PORT \
SCENARIO_DIR="$SCRIPT_DIR" \
AWCP_TRANSPORT=git \
AWCP_GIT_REMOTE_URL="$GIT_REPO_PATH" \
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

# Export config for MCP server and trigger script
export AWCP_GIT_REMOTE_URL="$GIT_REPO_PATH"
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
echo -e "${BLUE}Running MCP integration test with Git transport...${NC}"
echo -e "${YELLOW}(MCP server will auto-start Delegator Daemon with Git transport)${NC}"
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

# Show git history in bare repo
echo -e "${BLUE}Git repository history:${NC}"
echo "----------------------------------------"
cd "$GIT_REPO_PATH"
git log --oneline --all 2>/dev/null | head -10 || echo "(no commits)"
cd "$SCRIPT_DIR"
echo "----------------------------------------"
echo ""

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║     Git Transport Experiment Complete!                     ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
else
    echo -e "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║     Git Transport Experiment Failed                        ║${NC}"
    echo -e "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
fi

echo ""
echo "The file was transferred via Git (clone + push)!"
echo ""
echo "Logs:"
echo "  - logs/executor.log"
echo "  - logs/daemon.log"
echo ""
echo "Git bare repo: $GIT_REPO_PATH"
echo ""

exit $TEST_EXIT_CODE
