#!/bin/bash
# OpenClaw Executor - Quick Start
#
# Prerequisites:
#   - Node.js >= 22
#   - OpenClaw installed: npm install -g openclaw@latest
#   - API key: ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, or OPENROUTER_API_KEY
#
# Usage:
#   ./run.sh
#   PORT=10200 ./run.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
  echo -e "\n${YELLOW}Cleaning up...${NC}"
  [ -n "$EXECUTOR_PID" ] && kill $EXECUTOR_PID 2>/dev/null || true
  echo -e "${GREEN}✓ Cleanup complete${NC}"
}
trap cleanup EXIT

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         OpenClaw Executor Agent                            ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check for API keys
if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ] && [ -z "$OPENROUTER_API_KEY" ] && [ -z "$DEEPSEEK_API_KEY" ]; then
  echo -e "${YELLOW}⚠️  No AI API key found. Set one of:${NC}"
  echo "   - ANTHROPIC_API_KEY"
  echo "   - OPENAI_API_KEY"
  echo "   - OPENROUTER_API_KEY"
  echo "   - DEEPSEEK_API_KEY"
  echo ""
fi

# Check OpenClaw installation
if ! command -v openclaw &> /dev/null; then
  echo -e "${RED}❌ OpenClaw not found. Install with:${NC}"
  echo "   npm install -g openclaw@latest"
  exit 1
fi
echo -e "${GREEN}✓ OpenClaw found: $(openclaw --version 2>/dev/null || echo 'installed')${NC}"

# Build packages if needed
echo -e "\n${YELLOW}Building packages...${NC}"
cd "$ROOT_DIR"
npm run build > /dev/null 2>&1
echo -e "${GREEN}✓ Build complete${NC}"

cd "$SCRIPT_DIR"

# Install dependencies
if [ ! -d "node_modules" ]; then
  echo -e "\n${YELLOW}Installing dependencies...${NC}"
  npm install > /dev/null 2>&1
  echo -e "${GREEN}✓ Dependencies installed${NC}"
fi

# Start Executor Agent
echo -e "\n${BLUE}Starting OpenClaw Executor Agent...${NC}"
npx tsx src/agent.ts 2>&1 &
EXECUTOR_PID=$!

# Wait for Executor to be ready
PORT="${PORT:-10200}"
echo -e "${YELLOW}Waiting for services to start...${NC}"
for i in {1..60}; do
  if curl -s "http://localhost:$PORT/health" 2>/dev/null | grep -q '"status"'; then
    echo -e "${GREEN}✓ Executor started (PID: $EXECUTOR_PID)${NC}"
    break
  fi
  if [ $i -eq 60 ]; then
    echo -e "${RED}❌ Executor failed to start${NC}"
    exit 1
  fi
  sleep 1
done

echo ""
echo -e "${GREEN}Ready! Press Ctrl+C to stop.${NC}"
echo ""

# Wait for processes
wait
