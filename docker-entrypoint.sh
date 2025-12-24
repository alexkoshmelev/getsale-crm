#!/bin/sh
set -e

# Save current working directory
ORIGINAL_DIR=$(pwd)

echo "Building shared packages..."

# Build shared packages in correct order (types -> events -> utils)
# Use absolute path to avoid changing directory
cd /app

# Build types first
if ! npm run build --workspace=shared/types; then
  echo "Warning: Failed to build @getsale/types, continuing anyway..."
fi

# Build events (depends on types)
if ! npm run build --workspace=shared/events; then
  echo "Warning: Failed to build @getsale/events, continuing anyway..."
fi

# Build utils (depends on events)
if ! npm run build --workspace=shared/utils; then
  echo "Warning: Failed to build @getsale/utils, continuing anyway..."
fi

echo "Shared packages build completed"

# Return to original directory before executing command
cd "$ORIGINAL_DIR"

# Execute the main command
exec "$@"

