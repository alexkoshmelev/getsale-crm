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
  
  # Build types first (required for other packages)
  echo "Building @getsale/types..."
  if ! npm run build --workspace=shared/types; then
    echo "⚠️  Warning: Failed to build @getsale/types"
    # Check if dist directory exists (might be cached from previous build)
    if [ ! -d "/app/shared/types/dist" ]; then
      echo "❌ Error: @getsale/types dist directory missing and build failed"
      exit 1
    else
      echo "ℹ️  Using existing @getsale/types build"
    fi
  fi
  
  # Build events (depends on types)
  echo "Building @getsale/events..."
  if ! npm run build --workspace=shared/events; then
    echo "⚠️  Warning: Failed to build @getsale/events"
    # Check if dist directory exists (might be cached from previous build)
    if [ ! -d "/app/shared/events/dist" ]; then
      echo "❌ Error: @getsale/events dist directory missing and build failed"
      exit 1
    else
      echo "ℹ️  Using existing @getsale/events build"
    fi
  fi
  
  # Build utils (depends on events)
  echo "Building @getsale/utils..."
  if ! npm run build --workspace=shared/utils; then
    echo "⚠️  Warning: Failed to build @getsale/utils"
    # Check if dist directory exists (might be cached from previous build)
    if [ ! -d "/app/shared/utils/dist" ]; then
      echo "❌ Error: @getsale/utils dist directory missing and build failed"
      exit 1
    else
      echo "ℹ️  Using existing @getsale/utils build"
    fi
  fi
  
  echo "✅ Shared packages build completed"
  
  # Return to original directory
  cd "$ORIGINAL_DIR"
fi

# Execute the command
exec "$@"
