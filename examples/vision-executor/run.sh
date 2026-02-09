#!/bin/bash
# Vision Executor - One-click startup script
#
# Prerequisites:
#   - Node.js >= 22
#   - Synergy installed: npm install -g @ericsanchezok/synergy@latest
#   - API key: ANTHROPIC_API_KEY or OPENAI_API_KEY
#
# Usage:
#   ./run.sh
#   PORT=10200 ./run.sh
#   AWCP_TRANSPORT=archive ./run.sh  # Use archive transport instead of sshfs

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SCRIPT_DIR"

# Port configuration (default: 10200)
EXECUTOR_PORT="${PORT:-10200}"
SYNERGY_PORT="${SYNERGY_PORT:-2026}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
  echo -e "\n${YELLOW}Cleaning up...${NC}"
  [ -n "$SYNERGY_PID" ] && kill $SYNERGY_PID 2>/dev/null || true
  [ -n "$EXECUTOR_PID" ] && kill $EXECUTOR_PID 2>/dev/null || true
  echo -e "${GREEN}✓ Cleanup complete${NC}"
}
trap cleanup EXIT

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         Vision Executor Agent (Multimodal)                 ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check for API keys
if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ] && [ -z "$SII_API_KEY" ]; then
  echo -e "${YELLOW}⚠️  No AI API key found. Set one of:${NC}"
  echo "   - ANTHROPIC_API_KEY"
  echo "   - OPENAI_API_KEY"
  echo "   - SII_API_KEY"
  echo ""
fi

# Check Synergy installation
if ! command -v synergy &> /dev/null; then
  echo -e "${RED}❌ Synergy not found. Install with:${NC}"
  echo "   npm install -g @ericsanchezok/synergy@latest"
  exit 1
fi
echo -e "${GREEN}✓ Synergy found${NC}"

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

# Create directories
mkdir -p workdir temp logs

# Synergy configuration for fully automated execution
# - permission: Allow all operations without asking, deny question tool
# - interaction: Disable system-level interactions (agent switch, plan prompts)
SYNERGY_CONFIG_CONTENT='{"permission":{"*":"allow","question":"deny"},"interaction":false}'
export SYNERGY_CONFIG_CONTENT

# Start Synergy server
echo -e "\n${BLUE}Starting Synergy server on :${SYNERGY_PORT}...${NC}"
synergy serve --port $SYNERGY_PORT > logs/synergy.log 2>&1 &
SYNERGY_PID=$!

# Wait for Synergy to be ready
for i in {1..30}; do
  if curl -s http://localhost:$SYNERGY_PORT/global/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Synergy started (PID: $SYNERGY_PID)${NC}"
    break
  fi
  if [ $i -eq 30 ]; then
    echo -e "${RED}❌ Synergy failed to start. Check logs/synergy.log${NC}"
    exit 1
  fi
  sleep 1
done

# Start Executor Agent
echo -e "\n${BLUE}Starting Vision Executor on :${EXECUTOR_PORT}...${NC}"
PORT=$EXECUTOR_PORT SYNERGY_URL="http://localhost:$SYNERGY_PORT" SCENARIO_DIR="$SCRIPT_DIR" npx tsx src/agent.ts > logs/executor.log 2>&1 &
EXECUTOR_PID=$!

# Wait for Executor to be ready
for i in {1..10}; do
  if curl -s http://localhost:$EXECUTOR_PORT/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Executor started (PID: $EXECUTOR_PID)${NC}"
    break
  fi
  if [ $i -eq 10 ]; then
    echo -e "${RED}❌ Executor failed to start. Check logs/executor.log${NC}"
    exit 1
  fi
  sleep 1
done

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Vision Executor Ready! (Multimodal)                    ║${NC}"
echo -e "${GREEN}╠════════════════════════════════════════════════════════════════╣${NC}"
printf "${GREEN}║  Agent Card:  http://localhost:%-5s/.well-known/agent-card.json║${NC}\n" "$EXECUTOR_PORT"
printf "${GREEN}║  A2A:         http://localhost:%-5s/a2a                        ║${NC}\n" "$EXECUTOR_PORT"
printf "${GREEN}║  AWCP:        http://localhost:%-5s/awcp                       ║${NC}\n" "$EXECUTOR_PORT"
printf "${GREEN}║  Synergy:     http://localhost:%-5s                            ║${NC}\n" "$SYNERGY_PORT"
printf "${GREEN}║  Transport:   %-48s║${NC}\n" "${AWCP_TRANSPORT:-sshfs}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Logs:"
echo "  - logs/synergy.log"
echo "  - logs/executor.log"
echo ""
echo "Press Ctrl+C to stop..."

# Wait for processes
wait
