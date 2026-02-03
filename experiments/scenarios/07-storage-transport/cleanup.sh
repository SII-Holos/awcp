#!/bin/bash
# Cleanup script for 07-storage-transport scenario

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Cleaning up 07-storage-transport..."

# Kill any remaining processes
pkill -f "storage-server.ts" 2>/dev/null || true

# Clean directories
rm -rf workdir/* exports/* temp/* storage/* 2>/dev/null || true

echo "Cleanup complete"
