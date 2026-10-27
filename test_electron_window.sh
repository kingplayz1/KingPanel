#!/bin/bash
set -e

echo "Testing Electron window opens and loads renderer..."

# Clean up any existing processes
taskkill /IM electron.exe /F 2>/dev/null; taskkill /IM node.exe /F 2>/dev/null

# Start Electron app in background
echo "Starting Electron app..."
npx electron electron-main.cjs > electron.log 2>&1 &
ELECTRON_PID=$!
echo "Electron PID: $ELECTRON_PID"

# Wait for Electron app to initialize and backend to be ready
echo "Waiting for backend to be ready (max 30 seconds)..."
BACKEND_READY=0
for i in {1..30}; do
  if curl -s --max-time 1 http://127.0.0.1:3000 > /dev/null; then
    echo "Backend is ready at attempt $i"
    BACKEND_READY=1
    break
  fi
  sleep 1
done

if [ $BACKEND_READY -eq 0 ]; then
  echo "ERROR: Backend did not become ready in time"
  kill $ELECTRON_PID 2>/dev/null
  exit 1
fi

# Give a bit more time for the window to be created (the window is created after backend ready in the code)
echo "Waiting for window to be created..."
sleep 5

# Check if Electron process is still running
if tasklist | findstr /I "electron.exe" > /dev/null; then
  echo "PASS: Electron process is still running"
else
  echo "FAIL: Electron process has exited"
  # Check the log for errors
  if [ -f electron.log ]; then
    echo "Electron log:"
    cat electron.log
  fi
  kill $ELECTRON_PID 2>/dev/null
  exit 1
fi

# Check if backend is still running (should be, as long as Electron window is open)
if tasklist | findstr /I "node.exe" > /dev/null; then
  echo "PASS: Backend process is still running"
else
  echo "FAIL: Backend process has exited"
  kill $ELECTRON_PID 2>/dev/null
  exit 1
fi

# If we got here, both Electron and backend are running, which indicates the window opened and the renderer is loaded (since the Electron app only proceeds to create the window after the backend is ready)
echo "PASS: Electron window opened and renderer loaded (inferred from Electron and backend processes running)"

# Clean up
echo "Stopping Electron app..."
kill $ELECTRON_PID 2>/dev/null
# Give a moment for the app to clean up the backend
sleep 2
taskkill /IM electron.exe /F 2>/dev/null; taskkill /IM node.exe /F 2>/dev/null

echo "Test completed successfully."