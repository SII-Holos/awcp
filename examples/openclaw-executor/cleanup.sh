#!/bin/bash
# Cleanup script for OpenClaw Executor
#
# Removes generated files and temporary data

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Cleaning up OpenClaw Executor..."

# Remove build artifacts
rm -rf dist
rm -rf node_modules

# Remove temporary files
rm -rf workdir/*
rm -rf temp/*
rm -rf logs/*
rm -rf .openclaw

echo "✓ Cleanup complete"
