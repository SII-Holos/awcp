#!/bin/bash
# Cleanup script for 01-local-basic scenario

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Cleaning up scenario..."

# Clean runtime directories
rm -rf "$SCRIPT_DIR/exports"/*
rm -rf "$SCRIPT_DIR/mounts"/*
rm -rf "$SCRIPT_DIR/logs"/*

# Reset workspace to original state
if [ -f "$SCRIPT_DIR/workspace/hello.txt.orig" ]; then
  cp "$SCRIPT_DIR/workspace/hello.txt.orig" "$SCRIPT_DIR/workspace/hello.txt"
fi

echo "Cleanup complete."
