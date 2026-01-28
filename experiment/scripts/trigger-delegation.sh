#!/bin/bash
# Trigger a delegation

cd "$(dirname "$0")/.."

echo "Creating delegation..."
npm run delegate -- "$@"
