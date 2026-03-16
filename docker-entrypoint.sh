#!/bin/sh
set -e

# Save current working directory (service directory)
ORIGINAL_DIR=$(pwd)

# Check if shared packages need to be built using absolute paths
# Since WORKDIR is set to /app/${SERVICE_PATH}, we need to check from /app
if [ ! -d "/app/shared/types/dist" ] || [ ! -d "/app/shared/events/dist" ] || [ ! -d "/app/shared/utils/dist" ] || [ ! -d "/app/shared/logger/dist" ] || [ ! -d "/app/shared/service-core/dist" ]; then
  echo "Building shared packages..."
  
  # Change to /app for workspace commands
  cd /app
  
  # Build types first (required for other packages)
  echo "Building @getsale/types..."
  if ! npm run build --workspace=shared/types; then
    echo "⚠️  Warning: Failed to build @getsale/types"
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
    if [ ! -d "/app/shared/events/dist" ]; then
      echo "❌ Error: @getsale/events dist directory missing and build failed"
      exit 1
    else
      echo "ℹ️  Using existing @getsale/events build"
    fi
  fi
  
  # Build logger (no shared deps)
  echo "Building @getsale/logger..."
  if ! npm run build --workspace=shared/logger; then
    echo "⚠️  Warning: Failed to build @getsale/logger"
    if [ ! -d "/app/shared/logger/dist" ]; then
      echo "❌ Error: @getsale/logger dist directory missing and build failed"
      exit 1
    else
      echo "ℹ️  Using existing @getsale/logger build"
    fi
  fi

  # Build utils (depends on events, logger)
  echo "Building @getsale/utils..."
  if ! npm run build --workspace=shared/utils; then
    echo "⚠️  Warning: Failed to build @getsale/utils"
    if [ ! -d "/app/shared/utils/dist" ]; then
      echo "❌ Error: @getsale/utils dist directory missing and build failed"
      exit 1
    else
      echo "ℹ️  Using existing @getsale/utils build"
    fi
  fi

  # Build service-core (depends on logger, utils, events)
  echo "Building @getsale/service-core..."
  if ! npm run build --workspace=shared/service-core; then
    echo "⚠️  Warning: Failed to build @getsale/service-core"
    if [ ! -d "/app/shared/service-core/dist" ]; then
      echo "❌ Error: @getsale/service-core dist directory missing and build failed"
      exit 1
    else
      echo "ℹ️  Using existing @getsale/service-core build"
    fi
  fi
  
  echo "✅ Shared packages build completed"
  
  # Return to original directory
  cd "$ORIGINAL_DIR"
fi

# Execute the command
exec "$@"
