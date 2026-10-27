# Phase F.3: Packaged-App Windows Smoke-Test Procedure

**Purpose**: Validate IS King Panel's installed EXE runtime behavior before release.
**Scope**: Fresh installation, no development server, pure packaged-app execution.
**Gate**: Required evidence for "Runtime" release gate.

---

## ⚠️ Prerequisites

- `IS King Panel Setup 1.0.0.exe` installed on a **clean Windows user account** or separate test machine
- No prior instance of the app installed under this user
- Administrator privileges for installation
- Optional: DevTools access (F12) for console inspection

---

## 📋 Test Environment Checklist

| Item | Required | Notes |
|------|---|---|
| Clean Windows user/account | ✅ Required | No prior app installations |
| Administrator rights | ✅ Required | For EXE installation |
| Network access (localhost) | ✅ Required | Backend must bind to 127.0.0.1:3000 |
| Sufficient disk space | ✅ Recommended | SQLite database + app data |
| .NET Framework 4.8+ | ✅ Required | Electron runtime dependency |
| Visual C++ Redistributable | ✅ Required | electron-builder NSIS dependency |

---

## 🔧 Installation

### Step 1: Install the EXE

1. Double-click `IS King Panel Setup 1.0.0.exe` (located in `dist_electron/`)
2. Accept the NSIS wizard prompts:
   - Click **Next** through the welcome/license screens
   - Choose **Default installation directory** or customize if desired
   - Check **Create desktop shortcut** and **Create Start menu shortcut** (recommended)
   - Click **Install**
3. Click **Finish** when installation completes

### Step 2: Verify Installation

1. Start → All Programs → IS King Panel → IS King Panel (or desktop shortcut)
2. Confirm the app window launches showing 'IS King Panel — Windows 11 Localhost Minecraft Server Workstation'
3. Note the initial state: should attempt to start backend automatically

---

## ▶️ Runtime Tests

### Test 1: Backend Auto-Initialization

| Expected | Actual |
|----------|--------|
| **Pass**: Backend starts automatically, waiting indicator appears, then "Backend is ready, creating window..." logs to console | |

**How to verify**:

1. Launch the app
2. Observe the window loading (may show a white/blank screen while backend starts)
3. After ~10-15 seconds, the main IS King Panel UI should appear
4. **Open DevTools** (F12 or right-click → Inspect) if available
5. Check the **Console** tab for these expected messages:
   ```
   [Backend] Starting backend from: ...
   [Backend] Backend is ready, creating window...
   IS King Panel Server running on http://0.0.0.0:3000
   ```
6. **Fail**: Any of the above missing, or error messages about "Backend startup timeout", "Database unavailable", or "Failed to start backend"

---

### Test 2: Session Establishment

| Expected | Actual |
|----------|--------|
| **Pass**: User can log in / register, session cookie set, UI becomes usable | |

**How to verify**:

1. If first launch: click **Register** or **Sign In** (whichever appears)
2. Complete the auth flow (OAuth or local credentials)
3. Verify the UI navigates away from login and shows the dashboard/overview
4. **Open DevTools → Application → Cookies** (or Resources → Cookies)
5. Confirm a `king_session` cookie exists and has a value
6. **Fail**: Login fails, redirects back to login, no `king_session` cookie appears, or UI stalls

---

### Test 3: Provider Connection / Disconnection

| Expected | Actual |
|----------|--------|
| **Pass**: Can connect Discord/github/Google, disconnect, UI reflects changes | |

**How to verify** (repeat for each provider):

1. Navigate to **Provider Connections** panel (Sidebar → relevant section)
2. Click **Connect** next to the desired provider (Discord, GitHub, or Google)
3. Complete the OAuth flow in the opened browser window
4. Return to the app — should show provider as **connected**
5. Click **Disconnect** — should show as **disconnected**
6. Verify the change persists after navigating to another panel and back
7. **Fail**: OAuth error, provider stays "connecting" indefinitely, disconnect has no effect

---

### Test 4: Password Change & Session Invalidation

| Expected | Actual |
|----------|--------|
| **Pass**: Password changes, all other sessions are forced to re-login | |

**How to verify**:

1. Navigate to **Account Security** or **Settings → Security**
2. Enter current password, new password, confirm new password
3. Submit the change form
4. **Expected**: Form confirms success, toast/notification appears
5. **Critical**: Open a new browser/incognito window, navigate to the app, and attempt to use the **old** credentials — should be rejected
6. Use the **same** window, log out and log back in with **new** credentials — should succeed
7. **Fail**: Old credentials still work, no toast appears, change fails validation

---

### Test 5: Database Persistence Across Restarts

| Expected | Actual |
|----------|--------|
| **Pass**: SQLite database in APPDATA survives app restart; data persists | |

**How to verify**:

1. **Note the database location**: After first launch, check DevTools → Application → Storage → IndexedDB/SQLite, or file explorer at:
   `%APPDATA%\IS King Panel\database\isking_panel.sqlite`
2. Close the app completely (File → Exit, or taskbar → right-click → Close window)
3. Re-launch the app from desktop/start menu
4. Wait for backend initialization
5. Verify your prior data is still present (servers listed, profiles, settings, etc.)
6. **Fail**: Data lost, app prompts for re-setup, new database created, or error about missing/invalid database

---

### Test 6: MongoDB Connectivity (if configured)

| Expected | Actual |
|----------|--------|
| **Pass**: MongoDB connection works, data push/pull flows | |

**How to verify** (only if MongoDB is configured in the app):

1. Navigate to **Database → Engine Configuration**
2. Verify MongoDB URI is properly set (or leave as default localhost)
3. If MongoDB is configured, attempt to push a test collection
4. Check console for connection success/failure messages
5. **Fail**: Connection timeout, auth error, or MongoDB unavailable message

---

## 📊 Pass/Fail Criteria

| Criterion | Required |
|---|---|
| **Build passes** | `tsc --noEmit` → 0 errors ✅ Already verified |
| **Installer installs** | EXE installs without errors on clean machine |
| **Backend auto-initializes** | Startup logs show "Backend is ready" |
| **Session establishment** | Login/register works, `king_session` cookie set |
| **Provider connections** | At least one OAuth provider connect/disconnect works |
| **Password change** | Changes password, invalidates other sessions |
| **Data persistence** | Data survives app restart in APPDATA directory |
| **No critical errors** | Console shows no unhandled errors on core flows |

**Release gate**: Pass all 7 criteria above → Runtime gate cleared.

---

## 🛠️ Troubleshooting Guide

| Symptom | Likely Cause | Fix |
|---|---|---|
| Backend startup timeout | Port 3000 already in use; firewall blocking; missing VC++ redist | Kill other processes on 3000; allow port; install VC++ redist |
| "Database unavailable" on first launch | SQLite file permissions; APPDATA path inaccessible; file locked | Run as admin; check `%APPDATA%\IS King Panel\database\` permissions |
| OAuth flow stalls / never completes | Missing `allowToChangeInstallationDirectory`; NSIS shortcut conflict; callback URL mismatch | Reinstall; ensure no conflicting installs |
| Password change has no effect | Backend not restarted after change; session not invalidated | Restart app; check DevTools console for errors |
| Data lost after restart | Database written to dist/ instead of APPDATA; wrong env config | Verify `APPDATA_DB_DIR` is set correctly in packaged backend |

---

## 📝 Post-Test Actions

### If All Tests Pass:
- ✅ Runtime gate cleared
- ✅ Proceed to "Distribution readiness" gate review
- ✅ Code and configuration are release-ready (pending signing)

### If Any Test Fails:
1. Document the failure with:
   - Exact error messages
   - Screenshots (especially DevTools console)
   - Steps to reproduce
   - OS version and app version
2. Review the **Troubleshooting Guide** above
3. Apply the suggested fix
4. Re-run the smoke test from the beginning
5. If the fix requires source changes, create a follow-up task

### If Uncertain:
- Run the test on a **second clean machine** if available
- Isolate one variable at a time (e.g., test only backend init, then only login, then only persistence)
- Check the app logs at `%APPDATA%\IS King Panel\logs\` for any runtime errors

---

## 📈 Release Gate Summary

| Gate | Status (after smoke test) |
|---|---|
| **Build** | ✅ TypeScript 0 errors; installer generated |
| **Packaging** | ✅ Installer installs on target machine |
| **Runtime** | ⬜ **Pending** (this procedure) |
| **Security** | ⬜ **Pending** (auth/OAuth/password flows) |
| **Persistence** | ⬜ **Pending** (database restart survival) |
| **Distribution** | ⬜ **Pending** (signing, credentials, versioning) |

---
*This procedure validates the packaged app's runtime behavior. A passing result on a clean machine is the required evidence for the "Runtime" release gate.*