#!/bin/bash
# Cleanup script for 06-openclaw-executor scenario

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Remove temp files
rm -rf workdir/*
rm -rf temp/*
rm -rf exports/*

# Keep workspace intact (has initial test files)

echo "Cleanup complete"
