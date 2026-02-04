#!/bin/bash
#
# Cleanup script for 08-git-transport experiment
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Kill any lingering processes
pkill -f "08-git-transport" 2>/dev/null || true

# Clean up directories (keep workspace and git-server for inspection)
rm -rf "$SCRIPT_DIR/temp"/* 2>/dev/null || true
rm -rf "$SCRIPT_DIR/workdir"/* 2>/dev/null || true
rm -rf "$SCRIPT_DIR/logs"/* 2>/dev/null || true

echo "Cleanup complete"
