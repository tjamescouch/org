#!/usr/bin/env bash
set -e

# Ensure no stray server process is running before building
pkill -f cchat_server || true
# Build binaries
make clean all

# Ensure no previous instance is running before starting new server
pkill -f cchat_server || true
# Start server in background
./cchat_server &
SERVER_PID=$!
sleep 1 # give it time to start

# Run client, send a message, capture output
OUTPUT=$(echo "hello world" | ./cchat_client 127.0.0.1)

kill $SERVER_PID

# Verify response contains the echoed line with prefix
if [[ "$OUTPUT" == *"[SERVER] hello world"* ]]; then
    echo "E2E test passed"
    exit 0
else
    echo "E2E test failed"
    echo "Output was: $OUTPUT"
    exit 1
fi
