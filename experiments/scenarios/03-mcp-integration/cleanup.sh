#!/bin/bash
#
# Cleanup script for 03-mcp-integration scenario
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Kill any orphaned sshfs processes related to this scenario
pkill -f "sshfs.*$SCRIPT_DIR" 2>/dev/null || true

# Also kill any sshfs processes using our mount directory
pkill -f "sshfs.*03-mcp-integration" 2>/dev/null || true

# Wait a moment for processes to die
sleep 0.5

# Unmount any SSHFS mounts
if [ -d "$SCRIPT_DIR/mounts" ]; then
    for mount in "$SCRIPT_DIR/mounts"/*; do
        if [ -d "$mount" ]; then
            umount "$mount" 2>/dev/null || diskutil unmount force "$mount" 2>/dev/null || true
            rmdir "$mount" 2>/dev/null || true
        fi
    done
fi

# Clean up exports
rm -rf "$SCRIPT_DIR/exports"/* 2>/dev/null || true

# Clean up temporary keys that might have been created
rm -rf /tmp/awcp/client-keys/mount-* 2>/dev/null || true

# Clean up logs (optional - keep for debugging)
# rm -rf "$SCRIPT_DIR/logs"/* 2>/dev/null || true

echo "Cleanup complete"
