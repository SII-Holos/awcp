#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export SCENARIO_DIR="$SCRIPT_DIR"

echo ""
echo -e "\033[0;34m╔════════════════════════════════════════════════════════════╗\033[0m"
echo -e "\033[0;34m║         AWCP Admission Control Test                        ║\033[0m"
echo -e "\033[0;34m╚════════════════════════════════════════════════════════════╝\033[0m"
echo ""

# Build
echo -e "\033[1;33mBuilding packages...\033[0m"
cd "$SCRIPT_DIR/../../.."
npm run build > /dev/null 2>&1
echo -e "\033[0;32m✓ Build complete\033[0m"

# Setup directories
cd "$SCRIPT_DIR"
mkdir -p logs mounts exports workspace

# Cleanup function
cleanup() {
    echo ""
    echo -e "\033[1;33mCleaning up...\033[0m"
    if [ -n "$DELEGATOR_PID" ]; then
        kill $DELEGATOR_PID 2>/dev/null || true
    fi
    if [ -n "$EXECUTOR_PID" ]; then
        kill $EXECUTOR_PID 2>/dev/null || true
    fi
    echo -e "\033[0;32m✓ Cleanup complete\033[0m"
}
trap cleanup EXIT

# Start Delegator (with strict admission limits)
echo ""
echo -e "\033[0;34mStarting Delegator Daemon (strict admission)...\033[0m"
npx tsx start-delegator.ts > logs/delegator.log 2>&1 &
DELEGATOR_PID=$!
sleep 3
echo -e "\033[0;32m✓ Delegator Daemon started (PID: $DELEGATOR_PID)\033[0m"

# Start Executor Agent
echo -e "\033[0;34mStarting Executor Agent...\033[0m"
cd "$SCRIPT_DIR/../../shared/executor-agent"
npx tsx src/agent.ts > "$SCRIPT_DIR/logs/executor.log" 2>&1 &
EXECUTOR_PID=$!
cd "$SCRIPT_DIR"
sleep 3
echo -e "\033[0;32m✓ Executor Agent started (PID: $EXECUTOR_PID)\033[0m"

# Run tests
echo ""
echo -e "\033[0;34mRunning admission tests...\033[0m"
npx tsx trigger.ts

echo ""
echo -e "\033[0;32m╔════════════════════════════════════════════════════════════╗\033[0m"
echo -e "\033[0;32m║         Test Complete!                                     ║\033[0m"
echo -e "\033[0;32m╚════════════════════════════════════════════════════════════╝\033[0m"
echo ""
echo "Logs available in:"
echo "  - logs/delegator.log"
echo "  - logs/executor.log"
