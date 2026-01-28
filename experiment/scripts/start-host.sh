#!/bin/bash
# Start Host server only

cd "$(dirname "$0")/.."

CONFIG_FILE=${1:-configs/local.env}
echo "Starting Host server with config: $CONFIG_FILE"

npm run host -- "$CONFIG_FILE"
