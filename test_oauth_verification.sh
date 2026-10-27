#!/bin/bash
# OAuth Security Verification Tests for IS King Panel
# Requires: server running with OAuth env vars configured, test accounts in SQLite

BASE_URL="http://localhost:3000"
SESSION_COOKIE="test_session_token"  # Replace with actual session cookie from login

# Helper: make authenticated curl request
auth_curl() {
  local method="$1"
  local endpoint="$2"
  local body="$3"
  curl -s -b "session=${SESSION_COOKIE}" -X "${method}" "${BASE_URL}${endpoint}" \
    -H "Content-Type: application/json" ${body:+-d "${body}"}
}

# Helper: make unauthenticated curl request
unauth_curl() {
  local method="$1"
  local endpoint="$2"
  local body="$3"
  curl -s -X "${method}" "${BASE_URL}${endpoint}" \
    -H "Content-Type: application/json" ${body:+-d "${body}"}
}

echo "=== OAuth Security Verification Tests ==="
echo ""

# ============================================================
# Test 1: OAuth State Validation and Replay Protection
# ============================================================
echo "--- Test 1: OAuth State Validation and Replay Protection ---"

# 1a. Missing state parameter
echo "1a. Missing state parameter:"
result=$(unauth_curl POST "/api/auth/provider/link/start" '{"provider":"discord"}')
echo "  Response: ${result}"
# Should reject or require state - check implementation

# 1b. Expired/replayed state (will need active transaction)
# This requires starting a link/start transaction first
echo "  (Requires active OAuth state transaction - see test workflow below)"

echo ""

# ============================================================
# Test 2: Cross-Account Identity Conflicts
# ============================================================
echo "--- Test 2: Cross-Account Identity Conflicts ---"

# 2a. Link a provider to account 1
echo "2a. Link provider to account 1 (requires OAuth callback completion):"
# Note: Full test requires completing OAuth flow with provider
# For now, test the 409 conflict detection via the API
result=$(auth_curl POST "/api/auth/provider/link/callback/discord" '{}')
echo "  Callback response: ${result}"

# 2b. Try linking same provider_user_id to account 2 → should get 409
echo "  (Test 2b requires two test accounts with same provider identity attempted)"

echo ""

# ============================================================
# Test 3: Concurrent Linking
# ============================================================
echo "--- Test 3: Concurrent Linking ---"

# 3a. Send two simultaneous link attempts for same (provider, provider_user_id)
# This tests the UNIQUE constraint on oauth_identities table
echo "  (Test 3a requires: two POST requests to link callback with same provider+user_id)"
echo "  Expected: exactly one succeeds, other gets 409 Conflict"
echo "  (Run: curl -s -b session=... -X POST ... & curl -s -b session=... -X POST ...)"

echo ""

# ============================================================
# Test 4: Last Sign-In Method
# ============================================================
echo "--- Test 4: Last Sign-In Method ---"

# 4a. User with local + OAuth attempting to unlink OAuth → should succeed
echo "4a. Unlink OAuth when user has local + OAuth:"
result=$(auth_curl POST "/api/auth/provider/unlink" '{"provider":"discord"}')
echo "  Response: ${result}"

# 4b. User with ONLY OAuth attempting to unlink → should get 403
echo "  (Test 4b: user with provider='discord' only, no local login → expect 403)"

echo ""

# ============================================================
# Test 5: OAuth Cancellation and Errors
# ============================================================
echo "--- Test 5: OAuth Cancellation and Errors ---"

# 5a. Test that failed token exchange doesn't corrupt account
echo "5a. Failed token exchange leaves account unchanged:"
# This requires testing with invalid code, denied consent, etc.
echo "  (Implementation: try link/start with invalid provider, verify no account changes)"

# 5b. Expired state token rejected
echo "  (Test 5b: expired state → 400 'OAuth state token has expired')"

echo ""

# ============================================================
# Test 6: Authorization and Persistence
# ============================================================
echo "--- Test 6: Authorization and Persistence ---"

# 6a. Unauthenticated link/unlink → 401
echo "6a. Unauthenticated link attempt:"
result=$(unauth_curl POST "/api/auth/provider/link/start" '{"provider":"discord"}')
echo "  Response: ${result}"
# Should get 401 without valid session

# 6b. Successful link persists after server restart
echo "  (Test 6b: link a provider, restart server, verify /api/auth/providers still shows it)"

# 6c. Revoked session cannot perform linking
echo "  (Test 6c: after session revoke, link/start → 401)"

echo ""
echo "=== Verification Tests Complete ==="
echo "Run each section against your running server with test accounts."
echo "Mark passed/failed in the E.2.4 runtime test log."