#!/bin/bash
set -e

echo "=== Phase D Verification Tests ==="

# Clean up any existing processes
taskkill /IM electron.exe /F 2>/dev/null; taskkill /IM node.exe /F 2>/dev/null
echo "Cleaned up existing processes."

# Start backend
echo "Starting backend..."
node server.cjs > backend.log 2>&1 &
BACKEND_PID=$!
echo "Backend PID: $BACKEND_PID"

# Wait for backend to be ready
echo "Waiting for backend to be ready..."
for i in {1..30}; do
  if curl -s --max-time 1 http://127.0.0.1:3000 > /dev/null; then
    echo "Backend is ready at attempt $i"
    break
  fi
  sleep 1
done
if [ $i -eq 30 ]; then
  echo "ERROR: Backend did not become ready in time"
  kill $BACKEND_PID
  exit 1
fi

# Test 1: Invalid cookie returns 401
echo ""
echo "Test 1: Invalid cookie"
INVALID_COOKIE_RESPONSE=$(curl -b "king_session=invalidcookie123" -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/overview/stats || echo "0")
if [ "$INVALID_COOKIE_RESPONSE" = "401" ]; then
  echo "PASS: Invalid cookie returns 401"
else
  echo "FAIL: Invalid cookie returned $INVALID_COOKIE_RESPONSE (expected 401)"
fi

# Test 2: Valid login and session
echo ""
echo "Test 2: Valid login and session"
rm -f cookies.txt
LOGIN_RESPONSE=$(curl -c cookies.txt -X POST http://127.0.0.1:3000/api/auth/login -H "Content-Type: application/json" -d '{"identifier":"kingplayz","password":"kingpanel123"}' 2>&1)
if echo "$LOGIN_RESPONSE" | grep -q '"ok":true'; then
  echo "PASS: Login successful"
else
  echo "FAIL: Login failed"
  echo "Response: $LOGIN_RESPONSE"
  kill $BACKEND_PID
  exit 1
fi

# Check that we can access protected endpoint
PROTECTED_RESPONSE=$(curl -b cookies.txt -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/overview/stats || echo "0")
if [ "$PROTECTED_RESPONSE" = "200" ]; then
  echo "PASS: Protected endpoint accessible with valid cookie"
else
  echo "FAIL: Protected endpoint returned $PROTECTED_RESPONSE (expected 200) with valid cookie"
  kill $BACKEND_PID
  exit 1
fi

# Test 3: Revoked cookie (logout via API and then try to use cookie)
echo ""
echo "Test 3: Revoked cookie (via logout)"
LOGOUT_RESPONSE=$(curl -b cookies.txt -X POST http://127.0.0.1:3000/api/auth/logout -s -o /dev/null -w "%{http_code}" || echo "0")
if [ "$LOGOUT_RESPONSE" = "200" ]; then
  echo "PASS: Logout successful"
else
  echo "FAIL: Logout returned $LOGOUT_RESPONSE (expected 200)"
  kill $BACKEND_PID
  exit 1
fi

# Now try to use the same cookie after logout
REVOKED_COOKIE_RESPONSE=$(curl -b cookies.txt -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/overview/stats || echo "0")
if [ "$REVOKED_COOKIE_RESPONSE" = "401" ]; then
  echo "PASS: Revoked cookie returns 401 after logout"
else
  echo "FAIL: Revoked cookie returned $REVOKED_COOKIE_RESPONSE (expected 401) after logout"
  kill $BACKEND_PID
  exit 1
fi

# Test 4: OAuth callback with invalid state (should return error)
echo ""
echo "Test 4: OAuth callback with invalid state"
OAUTH_CALLBACK_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3000/auth/callback?provider=discord&code=invalid_code&state=invalid_state" || echo "0")
# We expect a 200 (because the endpoint returns an HTML page with error) or maybe 400? Let's check the content.
# Actually, the endpoint will return an HTML page (because it tries to postMessage to opener) so status 200 but with error in page.
# We'll check that the response contains an error message.
OAUTH_CALLBACK_CONTENT=$(curl -s "http://127.0.0.1:3000/auth/callback?provider=discord&code=invalid_code&state=invalid_state" || echo "")
if echo "$OAUTH_CALLBACK_CONTENT" | grep -iq "error\|invalid"; then
  echo "PASS: OAuth callback with invalid state returns error indication"
else
  echo "FAIL: OAuth callback with invalid state does not show error"
  echo "Response: $OAUTH_CALLBACK_CONTENT"
fi

# Test 5: Verify that the 4 existing MongoDB accounts are still present
echo ""
echo "Test 5: Verify existing MongoDB accounts"
# We can't directly check MongoDB from here, but we can check that the verify-mongodb endpoint works for a known user.
# Let's try to verify the user "Mio_Sakura" (one of the existing users) by using the verify-mongodb endpoint.
# However, note that the verify-mongodb endpoint requires a session cookie? Actually, it's a POST that takes userId, username, email.
# We can call it without a session? Let's check the code: it's a POST to /api/auth/verify-mongodb and it doesn't check session.
# So we can call it directly.
VERIFY_RESPONSE=$(curl -s -X POST http://127.0.0.1:3000/api/auth/verify-mongodb -H "Content-Type: application/json" -d '{"userId":"op-mio","username":"Mio_Sakura","email":"mio.sakura@kingsmp.net"}' || echo "")
if echo "$VERIFY_RESPONSE" | grep -q '"ok":true'; then
  echo "PASS: Existing user Mio_Sakura verifies successfully"
else
  echo "FAIL: Existing user Mio_Sakura verification failed"
  echo "Response: $VERIFY_RESPONSE"
fi

# Clean up
echo ""
echo "Stopping backend..."
kill $BACKEND_PID
wait $BACKEND_PID 2>/dev/null
echo "Backend stopped."

echo ""
echo "=== Phase D Verification Tests Completed ==="