#!/bin/bash
#
# Run the 09-multimodal-test AWCP experiment
#
# Tests multimodal capabilities:
# - Image analysis and understanding
# - File organization based on image content
# - Generating reports from visual inspection
#
# Prerequisites:
#   - OpenClaw installed: npm install -g openclaw@latest
#   - API key: SII_API_KEY (with multimodal model support)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OPENCLAW_EXECUTOR_DIR="$ROOT_DIR/examples/openclaw-executor"
export SCENARIO_DIR="$SCRIPT_DIR"

# Port configuration
EXECUTOR_PORT="${EXECUTOR_PORT:-10200}"
OPENCLAW_PORT="${OPENCLAW_PORT:-18789}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     AWCP Multimodal Capability Test                        ║${NC}"
echo -e "${CYAN}║                                                            ║${NC}"
echo -e "${CYAN}║  Tests:                                                    ║${NC}"
echo -e "${CYAN}║  • Image analysis and content understanding                ║${NC}"
echo -e "${CYAN}║  • File organization based on visual content               ║${NC}"
echo -e "${CYAN}║  • Report generation from image inspection                 ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
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
if [ -z "$SII_API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ]; then
    echo -e "${RED}Error: No multimodal-capable API key found.${NC}"
    echo "Set one of:"
    echo "   - SII_API_KEY (recommended)"
    echo "   - ANTHROPIC_API_KEY"
    echo "   - OPENAI_API_KEY"
    exit 1
fi
echo -e "${GREEN}✓ API key configured${NC}"

# Select model based on environment
if [ -n "$SII_API_KEY" ]; then
    export SII_MODEL="${SII_MODEL:-sonnet}"
    echo -e "${GREEN}✓ Using SII provider with model: ${SII_MODEL}${NC}"
fi

echo -e "${GREEN}✓ Dependencies OK${NC}"
echo ""

# Build packages if needed
echo -e "${YELLOW}Building packages...${NC}"
cd "$ROOT_DIR"
npm run build > /dev/null 2>&1 || true  # Ignore MCP build errors
echo -e "${GREEN}✓ Build complete${NC}"
echo ""

# Return to scenario directory
cd "$SCRIPT_DIR"

# Create required directories
mkdir -p logs workdir temp exports

# Check if workspace has test images
if [ ! "$(ls -A workspace 2>/dev/null)" ]; then
    echo -e "${YELLOW}Setting up test workspace with sample images...${NC}"
    
    # Create some test files to demonstrate multimodal capabilities
    mkdir -p workspace/images workspace/documents
    
    # Create a README
    cat > workspace/README.md << 'EOF'
# Multimodal Test Workspace

This workspace is for testing AWCP multimodal capabilities.

## Instructions

Place your test images in the `images/` directory, then run the test.

The AI will:
1. Analyze each image
2. Categorize them by content
3. Generate a detailed report

## Supported formats
- JPG/JPEG
- PNG
- GIF
- WebP
EOF

    # Create a placeholder file
    echo "Place your test images here" > workspace/images/.gitkeep
    
    echo -e "${GREEN}✓ Workspace initialized${NC}"
    echo ""
    echo -e "${YELLOW}⚠️  Please add test images to: ${SCRIPT_DIR}/workspace/images/${NC}"
    echo -e "${YELLOW}   Then run this script again.${NC}"
    echo ""
    exit 0
fi

echo -e "${GREEN}✓ Workspace contains files${NC}"

# Cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}Cleaning up...${NC}"
    
    if [ -n "$EXECUTOR_PID" ]; then
        kill $EXECUTOR_PID 2>/dev/null || true
    fi
    
    sleep 0.5
    ./cleanup.sh 2>/dev/null || true
    
    echo -e "${GREEN}✓ Cleanup complete${NC}"
}

trap cleanup EXIT

# Set executor URL
export EXECUTOR_URL="http://localhost:$EXECUTOR_PORT/awcp"
export EXECUTOR_BASE_URL="http://localhost:$EXECUTOR_PORT"

# Check if openclaw-executor is already running
if curl -s http://localhost:$EXECUTOR_PORT/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ OpenClaw Executor already running on :${EXECUTOR_PORT}${NC}"
    EXECUTOR_ALREADY_RUNNING=true
else
    # Start OpenClaw Executor Agent
    echo -e "${BLUE}Starting OpenClaw Executor on :${EXECUTOR_PORT}...${NC}"
    cd "$OPENCLAW_EXECUTOR_DIR"

    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        npm install > /dev/null 2>&1
    fi

    PORT=$EXECUTOR_PORT \
    OPENCLAW_PORT=$OPENCLAW_PORT \
    SCENARIO_DIR="$SCRIPT_DIR" \
    AWCP_TRANSPORT=archive \
    npx tsx src/agent.ts > "$SCRIPT_DIR/logs/executor.log" 2>&1 &
    EXECUTOR_PID=$!

    cd "$SCRIPT_DIR"

    # Wait for Executor to be ready
    echo -e "${YELLOW}Waiting for OpenClaw Gateway and Executor to start...${NC}"
    for i in {1..60}; do
        if curl -s http://localhost:$EXECUTOR_PORT/health 2>/dev/null | grep -q '"status":"ok"'; then
            echo -e "${GREEN}✓ OpenClaw Executor started (PID: $EXECUTOR_PID)${NC}"
            break
        fi
        if [ $i -eq 60 ]; then
            echo -e "${RED}Error: Executor failed to start. Check logs/executor.log${NC}"
            cat logs/executor.log 2>/dev/null | tail -20
            exit 1
        fi
        sleep 1
    done
fi

# Show workspace contents
echo ""
echo -e "${BLUE}Workspace contents:${NC}"
echo "----------------------------------------"
find workspace -type f -name "*.jpg" -o -name "*.jpeg" -o -name "*.png" -o -name "*.gif" -o -name "*.webp" 2>/dev/null | head -20 || echo "  (no images found)"
echo "----------------------------------------"
echo ""

# Run multimodal test
echo -e "${BLUE}Running multimodal capability test...${NC}"
echo ""

npx tsx trigger.ts
TEST_EXIT_CODE=$?

# Show results
echo ""
echo -e "${BLUE}Generated reports:${NC}"
echo "----------------------------------------"
if [ -f "workspace/analysis_report.md" ]; then
    cat workspace/analysis_report.md
else
    echo "  (no report generated)"
fi
echo "----------------------------------------"
echo ""

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║     Multimodal Capability Test Passed!                     ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
else
    echo -e "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║     Multimodal Capability Test Failed                      ║${NC}"
    echo -e "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
fi

echo ""
echo "Logs available in:"
echo "  - logs/executor.log"
echo "  - logs/daemon.log"
echo ""

exit $TEST_EXIT_CODE
