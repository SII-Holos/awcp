#!/bin/bash
# Cleanup script for vision-executor
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$SCRIPT_DIR/workdir"/* "$SCRIPT_DIR/temp"/* "$SCRIPT_DIR/logs"/* 2>/dev/null || true
echo "Cleanup complete"
