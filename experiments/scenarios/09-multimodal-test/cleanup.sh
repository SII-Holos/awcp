#!/bin/bash
# Cleanup script for 09-multimodal-test scenario

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Kill any running processes
pkill -f "09-multimodal-test" 2>/dev/null || true

# Clean temporary directories
rm -rf "$SCRIPT_DIR/workdir"/* 2>/dev/null || true
rm -rf "$SCRIPT_DIR/exports"/* 2>/dev/null || true
rm -rf "$SCRIPT_DIR/temp"/* 2>/dev/null || true

echo "Cleanup complete"
