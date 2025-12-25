#!/bin/sh
set -e

# Save current working directory (service directory)
ORIGINAL_DIR=$(pwd)

# Check if shared packages need to be built using absolute paths
# Since WORKDIR is set to /app/${SERVICE_PATH}, we need to check from /app
if [ ! -d "/app/shared/types/dist" ] || [ ! -d "/app/shared/events/dist" ] || [ ! -d "/app/shared/utils/dist" ]; then
  echo "Building shared packages..."
  
  # Change to /app for workspace commands
  cd /app
  
  # Build types first (with error handling - non-fatal)
  # Temporarily disable set -e for build commands to allow graceful failure
  set +e
  if ! npm run build --workspace=shared/types; then
    echo "Warning: Failed to build @getsale/types, continuing anyway..."
  fi
  
  # Build events (depends on types) - with error handling
  if ! npm run build --workspace=shared/events; then
    echo "Warning: Failed to build @getsale/events, continuing anyway..."
  fi
  
  # Build utils (depends on events) - with error handling
  if ! npm run build --workspace=shared/utils; then
    echo "Warning: Failed to build @getsale/utils, continuing anyway..."
  fi
  set -e
  
  echo "Shared packages build completed"
  
  # Return to original directory
  cd "$ORIGINAL_DIR"
fi

# Execute the command
exec "$@"