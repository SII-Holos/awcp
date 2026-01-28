#!/bin/bash
# Start both Host and Remote servers in local mode

cd "$(dirname "$0")/.."

echo "Starting AWCP Experiment in Local Mode..."
echo ""

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

# Start both servers
npm run start-local
