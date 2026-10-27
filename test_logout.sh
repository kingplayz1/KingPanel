#!/bin/bash
taskkill /IM electron.exe /F 2>/dev/null; taskkill /IM node.exe /F 2>/dev/null
echo "Starting Electron app..."
npx electron electron-main.cjs > electron.log 2>&1 &
ELECTRON_PID=$!
echo "Electron PID: $ELECTRON_PID"
echo "Waiting for backend to be ready..."
for i in {1..30}; do
  if curl -s --max-time 1 http://127.0.0.1:3000 > /dev/null; then
    echo "Backend is ready at attempt $i"
    break
  fi
  sleep 1
done
if [ $i -eq 30 ]; then
  echo "Backend did not become ready in time"
  kill $ELECTRON_PID
  exit 1
fi
echo "Testing login and session..."
rm -f cookies.txt
LOGIN_RESPONSE=$(curl -c cookies.txt -X POST http://127.0.0.1:3000/api/auth/login -H "Content-Type: application/json" -d '{"identifier":"kingplayz","password":"kingpanel123"}' 2>&1)
echo "Login response: $LOGIN_RESPONSE"
if echo "$LOGIN_RESPONSE" | grep -q '"ok":true'; then
  echo "Login successful"
else
  echo "Login failed"
  kill $ELECTRON_PID
  exit 1
fi
echo "Checking protected endpoint with session..."
PROTECTED_RESPONSE=$(curl -b cookies.txt http://127.0.0.1:3000/api/overview/stats 2>&1)
echo "Protected endpoint response: $PROTECTED_RESPONSE"
if echo "$PROTECTED_RESPONSE" | grep -q '"serverCount"'; then
  echo "Protected endpoint accessible"
else
  echo "Protected endpoint not accessible"
  kill $ELECTRON_PID
  exit 1
fi
echo "Testing logout..."
LOGOUT_RESPONSE=$(curl -b cookies.txt -X POST http://127.0.0.1:3000/api/auth/logout 2>&1)
echo "Logout response: $LOGOUT_RESPONSE"
if echo "$LOGOUT_RESPONSE" | grep -q '"ok":true'; then
  echo "Logout successful"
else
  echo "Logout failed"
  kill $ELECTRON_PID
  exit 1
fi
echo "Verifying session is invalidated after logout..."
PROTECTED_RESPONSE2=$(curl -b cookies.txt http://127.0.0.1:3000/api/overview/stats 2>&1)
echo "Protected endpoint response after logout: $PROTECTED_RESPONSE2"
if echo "$PROTECTED_RESPONSE2" | grep -q '"error":"Session expired or invalid"'; then
  echo "Session correctly invalidated after logout"
else
  echo "Session NOT invalidated after logout - TEST FAILED"
  kill $ELECTRON_PID
  exit 1
fi
echo "Stopping Electron app..."
kill $ELECTRON_PID
wait $ELECTRON_PID 2>/dev/null
echo "Electron app stopped."
echo "Logout and session revocation test PASSED"