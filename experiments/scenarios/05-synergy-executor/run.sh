#!/bin/bash
#
# Run the 05-synergy-executor AWCP experiment
#
# This scenario tests the full AWCP + MCP integration using Synergy as the executor.
# Unlike other scenarios that use a simple file-operation executor, this one uses
# the real Synergy AI coding agent to process tasks.
#
# Flow:
#   MCP Client (trigger.ts)
#       | stdio (JSON-RPC)
#   awcp-mcp server (auto-starts Delegator Daemon)
#       | INVITE/START + SSE events
#   synergy-executor (:10200)
#       | HTTP API
#   synergy serve (:2026)
#
# Prerequisites:
#   - Synergy installed: npm install -g @ericsanchezok/synergy@latest
#   - API key: ANTHROPIC_API_KEY or OPENAI_API_KEY
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SYNERGY_EXECUTOR_DIR="$ROOT_DIR/examples/synergy-executor"
export SCENARIO_DIR="$SCRIPT_DIR"

# Parse arguments
REMOTE_EXECUTOR=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --remote)
      REMOTE_EXECUTOR="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: ./run.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --remote <host:port>  Use remote executor (e.g., --remote 47.128.202.125:10200)"
      echo "  --help, -h            Show this help message"
      echo ""
      echo "Examples:"
      echo "  ./run.sh                                # Start local executor"
      echo "  ./run.sh --remote 47.128.202.125:10200  # Use remote executor"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Port configuration
EXECUTOR_PORT="${EXECUTOR_PORT:-10200}"
SYNERGY_PORT="${SYNERGY_PORT:-2026}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     AWCP + MCP + Synergy Executor Experiment               ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check dependencies
echo -e "${YELLOW}Checking dependencies...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is required but not installed.${NC}"
    exit 1
fi

# Only check local synergy if not using remote
if [ -z "$REMOTE_EXECUTOR" ]; then
    if ! command -v synergy &> /dev/null; then
        echo -e "${RED}Error: Synergy not found. Install with:${NC}"
        echo "   npm install -g @ericsanchezok/synergy@latest"
        exit 1
    fi

    # Check for API keys
    if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ] && [ -z "$SII_API_KEY" ]; then
        echo -e "${YELLOW}Warning: No AI API key found. Set one of:${NC}"
        echo "   - ANTHROPIC_API_KEY"
        echo "   - OPENAI_API_KEY"
        echo "   - SII_API_KEY"
        echo ""
    fi
fi

echo -e "${GREEN}✓ Dependencies OK${NC}"
echo ""

# Build packages if needed
echo -e "${YELLOW}Building packages...${NC}"
cd "$ROOT_DIR"
npm run build > /dev/null 2>&1
echo -e "${GREEN}✓ Build complete${NC}"
echo ""

# Return to scenario directory
cd "$SCRIPT_DIR"

# Create required directories
mkdir -p logs workdir temp exports

# Reset workspace with a simple project
echo -e "${YELLOW}Resetting workspace...${NC}"
cat > workspace/README.md << 'EOF'
# Test Project

This is a test project for AWCP + Synergy integration.

## Files
- hello.txt - A greeting file
EOF
echo "Hello, World!" > workspace/hello.txt
echo -e "${GREEN}✓ Workspace reset${NC}"

# Cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}Cleaning up...${NC}"
    
    # Only kill processes we started (not pre-existing ones)
    if [ -n "$SYNERGY_PID" ]; then
        kill $SYNERGY_PID 2>/dev/null || true
    fi
    if [ -n "$EXECUTOR_PID" ]; then
        kill $EXECUTOR_PID 2>/dev/null || true
    fi
    
    # Wait for processes to terminate
    sleep 0.5
    
    # Cleanup workdir
    ./cleanup.sh 2>/dev/null || true
    
    echo -e "${GREEN}✓ Cleanup complete${NC}"
}

trap cleanup EXIT

# Synergy configuration for fully automated execution
# - permission: Allow all operations without asking, deny question tool
# - interaction: Disable system-level interactions (agent switch, plan prompts)
SYNERGY_CONFIG_CONTENT='{"permission":{"*":"allow","question":"deny"},"interaction":false}'
export SYNERGY_CONFIG_CONTENT

# Determine executor URL based on mode
if [ -n "$REMOTE_EXECUTOR" ]; then
    # Remote mode: use provided address
    EXECUTOR_HOST="$REMOTE_EXECUTOR"
    export EXECUTOR_URL="http://${EXECUTOR_HOST}/awcp"
    export EXECUTOR_BASE_URL="http://${EXECUTOR_HOST}"
    
    echo -e "${BLUE}Using remote executor: ${EXECUTOR_HOST}${NC}"
    
    # Verify remote executor is reachable
    if curl -s --connect-timeout 5 "http://${EXECUTOR_HOST}/health" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Remote executor is reachable${NC}"
    else
        echo -e "${RED}Error: Cannot reach remote executor at ${EXECUTOR_HOST}${NC}"
        echo "Make sure the executor is running and the firewall allows port access."
        exit 1
    fi
else
    # Local mode: start executor locally
    export EXECUTOR_URL="http://localhost:$EXECUTOR_PORT/awcp"
    export EXECUTOR_BASE_URL="http://localhost:$EXECUTOR_PORT"

    # Check if synergy-executor is already running
    if curl -s http://localhost:$EXECUTOR_PORT/health > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Synergy Executor already running on :${EXECUTOR_PORT}${NC}"
        EXECUTOR_ALREADY_RUNNING=true
    else
        # Start Synergy server
        echo -e "${BLUE}Starting Synergy server on :${SYNERGY_PORT}...${NC}"
        
        # Check if synergy server is already running
        if curl -s http://localhost:$SYNERGY_PORT/global/health > /dev/null 2>&1; then
            echo -e "${GREEN}✓ Synergy server already running on :${SYNERGY_PORT}${NC}"
        else
            synergy serve --port $SYNERGY_PORT > logs/synergy.log 2>&1 &
            SYNERGY_PID=$!
            
            # Wait for Synergy to be ready
            for i in {1..30}; do
                if curl -s http://localhost:$SYNERGY_PORT/global/health > /dev/null 2>&1; then
                    echo -e "${GREEN}✓ Synergy server started (PID: $SYNERGY_PID)${NC}"
                    break
                fi
                if [ $i -eq 30 ]; then
                    echo -e "${RED}Error: Synergy failed to start. Check logs/synergy.log${NC}"
                    exit 1
                fi
                sleep 1
            done
        fi

        # Start Synergy Executor Agent
        echo -e "${BLUE}Starting Synergy Executor on :${EXECUTOR_PORT}...${NC}"
        cd "$SYNERGY_EXECUTOR_DIR"

        # Install dependencies if needed
        if [ ! -d "node_modules" ]; then
            npm install > /dev/null 2>&1
        fi

        PORT=$EXECUTOR_PORT \
        SYNERGY_URL="http://localhost:$SYNERGY_PORT" \
        SCENARIO_DIR="$SCRIPT_DIR" \
        AWCP_TRANSPORT=archive \
        npx tsx src/agent.ts > "$SCRIPT_DIR/logs/executor.log" 2>&1 &
        EXECUTOR_PID=$!

        cd "$SCRIPT_DIR"

        # Wait for Executor to be ready
        for i in {1..10}; do
            if curl -s http://localhost:$EXECUTOR_PORT/health > /dev/null 2>&1; then
                echo -e "${GREEN}✓ Synergy Executor started (PID: $EXECUTOR_PID)${NC}"
                break
            fi
            if [ $i -eq 10 ]; then
                echo -e "${RED}Error: Executor failed to start. Check logs/executor.log${NC}"
                exit 1
            fi
            sleep 1
        done
    fi
fi

# Show workspace before
echo ""
echo -e "${BLUE}Workspace before:${NC}"
echo "----------------------------------------"
cat workspace/hello.txt
echo "----------------------------------------"
echo ""

# Run MCP integration tests
echo -e "${BLUE}Running MCP integration tests with Synergy executor...${NC}"
echo -e "${YELLOW}(MCP server will auto-start Delegator Daemon)${NC}"
echo ""

npx tsx trigger.ts
TEST_EXIT_CODE=$?

# Show workspace after
echo ""
echo -e "${BLUE}Workspace after:${NC}"
echo "----------------------------------------"
cat workspace/hello.txt
echo "----------------------------------------"
echo ""

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║     Synergy Executor Integration Tests Passed!             ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
else
    echo -e "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║     Synergy Executor Integration Tests Failed              ║${NC}"
    echo -e "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
fi

echo ""
echo "Logs available in:"
echo "  - logs/synergy.log"
echo "  - logs/executor.log"
echo ""

exit $TEST_EXIT_CODE
