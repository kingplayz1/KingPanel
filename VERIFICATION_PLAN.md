# IS King Panel Session Security Verification Plan

This plan outlines tests to verify the secure session management implementation in IS King Panel.

## Prerequisites
- Ensure the application is built (`npm run build`)
- Ensure the backend server can start (`npm start` or `node dist/server.js`)
- Ensure SQLite database is initialized

## Test Cases

### 1. Local Login Session Creation
**Objective:** Verify that local login creates a cryptographically random session cookie and corresponding SQLite record.

**Steps:**
1. Start the backend server
2. Send POST request to `/api/auth/login` with valid local credentials (username: `Mio_Sakura`, password: `kingpanel123`)
3. Verify response:
   - Status code: 200
   - Contains `Set-Cookie` header with `king_session=` value
   - Cookie value is 64-character hex string (32 bytes)
   - Cookie attributes: `HttpOnly; Secure; SameSite=None; Max-Age=604800` (7 days in seconds)
4. Verify database:
   - Check `auth_sessions` table for new record
   - `session_id` matches cookie value
   - `user_id` corresponds to `Mio_Sakura` user
   - `provider` is `local`
   - `created_at` and `last_active_at` are set to current time

### 2. Session Validation Middleware
**Objective:** Verify that API endpoints require valid session and reject invalid/missing sessions.

**Steps:**
1. Without authentication, send GET request to `/api/overview/stats`
2. Verify response:
   - Status code: 401
   - Error message: "Authentication required" or "Session expired or invalid"
3. Login via local credentials to obtain valid session
4. Send GET request to `/api/overview/stats` with session cookie
5. Verify response:
   - Status code: 200
   - Returns server statistics data
6. Test with expired session:
   - Manually insert expired record into `auth_sessions` (set `last_active_at` to 8 days ago)
   - Attempt to access protected endpoint with expired session cookie
   - Verify 401 response and cookie clearance

### 3. Logout Session Invalidation
**Objective:** Verify that logout properly invalidates server-side session and clears client cookie.

**Steps:**
1. Login via local credentials to obtain valid session
2. Verify session exists in `auth_sessions` table
3. Send POST request to `/api/auth/logout` with session cookie
4. Verify response:
   - Status code: 200
   - Message: "Logged out successfully"
5. Verify server-side:
   - Session record removed from `auth_sessions` table
6. Verify client-side:
   - Response includes `Clear-Set-Cookie` header for `king_session`
7. Attempt to access protected endpoint with same cookie
8. Verify 401 response (session invalidated)

### 4. OAuth Login Session Handling
**Objective:** Verify that OAuth login creates secure sessions while preserving provider linking.

**Steps:**
1. Send POST request to `/api/auth/oauth-login` with mock OAuth code and state
2. Verify response:
   - Status code: 200
   - Contains `Set-Cookie` header with secure session
   - Returns user data with provider information
3. Verify database:
   - New session record created in `auth_sessions`
   - User record updated with OAuth provider linkage
   - `connectedProviders` array includes the OAuth provider
4. Test session protection:
   - Use obtained session to access protected endpoints
   - Verify successful authentication

### 5. Existing Users Preservation
**Objective:** Verify that the 4 existing MongoDB users remain functional after database migration.

**Steps:**
1. For each existing user (Kuro_Neko_JP, Aki_Craft99, Mio_Sakura, kingplayz):
   - Attempt login with known credentials
   - Verify successful authentication
   - Verify session creation and validation
   - Verify user-specific properties (role, limits, etc.)
2. Verify no duplicate accounts were created
3. Verify OAuth provider IDs are preserved in `oauthProviderIds` field

### 6. Session Expiry
**Objective:** Verify that sessions automatically expire after configured duration.

**Steps:**
1. Login to obtain valid session
2. Manually update session record to set `last_active_at` to 8 days ago
3. Attempt to access protected endpoint
4. Verify:
   - 401 response with "Session expired or invalid"
   - Session cookie cleared from response
   - Session record may be removed (depending on cleanup implementation)

### 7. Concurrent Sessions
**Objective:** Verify that multiple simultaneous sessions are handled correctly.

**Steps:**
1. Login same user from two different clients/devices
2. Verify two distinct session records exist in `auth_sessions`
3. Use both sessions to access protected endpoints
4. Verify both sessions work independently
5. Logout from one session
6. Verify:
   - One session record removed
   - Other session remains valid
   - Logged-out session cannot access protected endpoints

### 8. Security Headers
**Objective:** Verify that session cookie has appropriate security attributes.

**Steps:**
1. Login to obtain session cookie
2. Examine `Set-Cookie` header:
   - Contains `HttpOnly` flag
   - Contains `Secure` flag
   - Contains `SameSite=None`
   - Contains `Max-Age=604800` (7 days)
   - Does NOT contain `SameSite=Strict` or `SameSite=Lax` (None required for cross-origin Electron)

## Automation Scripts

The following helper scripts can be used for verification:

### Quick Login Test
```bash
# Local login
curl -X POST http://127.0.0.1:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"identifier":"Mio_Sakura","password":"kingpanel123"}' \
  -v

# OAuth login (mock)
curl -X POST http://127.0.0.1:3000/api/auth/oauth-login \
  -H "Content-Type: application/json" \
  -d '{"provider":"discord","code":"mock_code","state":"mock_state","username":"testuser"}' \
  -v
```

### Protected Endpoint Test
```bash
# Replace with actual session cookie from login response
curl http://127.0.0.1:3000/api/overview/stats \
  -H "Cookie: king_session=your_session_here" \
  -v
```

### Logout Test
```bash
# Replace with actual session cookie
curl -X POST http://127.0.0.1:3000/api/auth/logout \
  -H "Cookie: king_session=your_session_here" \
  -v
```

## Expected Outcomes
All tests should pass with the current implementation. Any failures indicate issues that need to be addressed before proceeding to full Phase D verification with real OAuth providers.

## Notes
- Replace test credentials with actual values from `.local-users-db.json`
- For OAuth testing, mock codes are sufficient as the endpoint doesn't actually validate with providers
- Ensure server is running in development mode for detailed logging
- Check server console for any error messages during testing