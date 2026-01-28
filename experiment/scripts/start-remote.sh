#!/bin/bash
# Start Remote server only

cd "$(dirname "$0")/.."

CONFIG_FILE=${1:-configs/local.env}
echo "Starting Remote server with config: $CONFIG_FILE"

npm run remote -- "$CONFIG_FILE"
