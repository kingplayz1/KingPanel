# IS King Panel — Advanced Panel Audit

Audit of `E:\Minecraft_Server\mcpanel` (Electron + React + Express + SQLite/MongoDB).
Everything below was read or executed in this pass. Items marked **not verified**
were not inspected and must not be treated as working.

---

## 1. Architecture as found

| Layer | Location | Notes |
| --- | --- | --- |
| Electron shell | [electron-main.cjs](../electron-main.cjs) | Spawns `server.cjs` (bundled backend) as a child process, then loads the local URL. |
| Backend | [server.ts](../server.ts) — **9,000+ lines**, `startServer()` | One Express app. ~98 route definitions. Bundled to [server.cjs](../server.cjs) with esbuild for packaging. |
| Process manager | [server/process-supervisor.ts](../server/process-supervisor.ts) | Real `spawn` of `java`, readiness from actual console output, crash detection from exit codes, PID reconciliation on restart. |
| Job queue | [server/job-manager.ts](../server/job-manager.ts) | Long operations (install, backup, reinstall) run as cancellable jobs. |
| Renderer | [src/](../src) | React 19 + Vite. Simple Panel (`src/components/SimpleServerPanel.tsx`) and Advanced Panel (`src/views/*`). |
| Auth data | SQLite `auth_sessions` (sessions) + `.local-users-db.json` (accounts) | Sessions are server-side rows; the cookie is only the key. |
| Entitlement | `verifyAdvancedPanelAccess()` + `requireAdvancedPanel` in [server.ts](../server.ts) | Discord guild-membership + required-role check using the account's own OAuth grant, fail-closed. |

**Transport reality:** the supervisor emits real events (`line`, `state`) and
`GET /api/servers/:id/events` exposes them over SSE — but **no renderer code
opens an `EventSource`**. The console view instead polls
`GET /api/server-runtime/live-state` every 2.5 s. The data is real either way;
the SSE endpoint is currently unused by the UI.

---

## 2. Access control — the main finding

The panel binds `0.0.0.0` (`server.ts`, `httpServer.listen(PORT, '0.0.0.0')`), so
every route was reachable from the whole LAN, not only this PC.

Before this pass, **51 routes had no authentication at all**, including:

* `POST /api/server-runtime/power` — start / stop / restart / kill any server
* `POST /api/server-runtime/command` — write to the server's stdin
* `GET|POST /api/server-runtime/file`, `/files`, `/file-create`, `/file-delete`
* `DELETE /api/server-runtime/server` — delete a server folder
* `POST /api/server-runtime/reinstall`, `/backup-create`, `/backup-restore`
* `GET /api/servers`, `GET /api/servers/:id/events` (live console of any server)
* `GET /api/panel/telemetry` — host OS, RAM, disks, install paths
* `POST /api/system/browse-folders` — arbitrary directory listing of the machine
* `GET /api/database/overview`, `POST /api/database/provision-server`
* `GET /api/auth/users` — **all accounts plus the SQLite path**, anonymous

Two privilege-escalation paths also existed:

* `POST /api/database/admin/update-user` was gated by `requireAdvancedPanel`
  only, so any Discord-verified member could grant themselves `Super Admin` or
  overwrite another account's password.
* `POST /api/auth/users`-adjacent account data was readable anonymously.

### Fixed in this pass

* Every one of those 51 routes now requires `validateSession` (an
  allowlisted, line-by-line transform — see §6).
* `/api/auth/users` and `/api/database/admin/update-user` now require
  **Super Admin**, not merely Advanced-Panel entitlement.
* Audit records for user administration now attribute the real actor instead of a
  hard-coded name.

Still unauthenticated by design (all are credential entry points):
`/api/auth/login`, `/register`, `/url/:provider`, `/auth/callback`,
`/password-reset-request`, `/password-reset`, `/oauth-login`, `/session`,
`/logout`, and `/api/auth/reset-password` (loopback-only, see §4).

---

## 3. Feature inventory

Status legend: **Working** (verified by code read *and* execution),
**Partial** (works but has a documented gap), **Broken** (was non-functional),
**Unverified** (not inspected in this pass).

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| Account registration / login | Working | Executed through the UI (sign-up → Simple Panel) and in the test suite. Session row created; wrong password → 401. |
| Logout | Working | Test `logout invalidates the session server-side` proves the row is deleted and an old cookie replays as 401. |
| Session persistence | Working | Cookie is HTTP-only, 7-day server-side row, `last_active_at` refreshed per request. |
| Session list / revoke / revoke-others | **Broken → Fixed** | `SessionManagementPanel` called `GET /api/auth/sessions`, `POST .../revoke`, `POST .../revoke-others` — none existed (404). Implemented with per-user scoping. |
| Password change (signed in) | Working | `POST /api/auth/change-password`, `validateSession`. |
| Password reset (signed out) | **Broken → Fixed** | UI posted to `/api/auth/reset-password`, which did not exist. Implemented as **loopback-only**, rate-limited, single honest 404 for unknown accounts, all sessions invalidated on success. |
| Advanced Panel entitlement | Working | Gateway modal explains the three requirements; backend returns `403 ADVANCED_PANEL_REQUIRED` / `503` on Discord failure. Verified in UI and tests. |
| Simple Panel access for unverified users | Working | Verified in UI: non-entitled account gets the server list; Advanced Panel refuses. |
| Server registry (`/api/servers`) | Working | Lists real folders from the install root with real supervisor snapshots. `runtime` is now always an object (`stopped` when the supervisor has no record) instead of `null`. |
| Server create (provision folder) | Partial | Goes through the job queue, enforces per-account limit from the **stored** account (not the request body), refuses duplicate folders (409) and declined EULA. Real jar download not exercised in this pass. |
| Server start / stop / restart | Working (backend) | Supervisor writes `stop` to stdin, escalates to a tree kill after a grace period, detects readiness from `Done (…)!`, and reports `crashed` on unexpected exit. Verified refusal paths in tests (no jar / EULA not accepted / unknown action). |
| Duplicate start protection | Working | `supervisor.start()` returns `alreadyRunning` for a server already `starting`/`online`/`stopping`; the job queue returns `409 SERVER_BUSY`. |
| Console output | Working | From the real process stdout/stderr; adopted servers tail `logs/latest.log`. Renderer polls `live-state` (2.5 s). |
| Console command | Working | Length/null-byte validation, refuses when not `online`, refuses when reattached without stdin. Tested: stopped server → 400. |
| Live metrics | Working | CPU/RSS sampled from the OS via PowerShell, 2 s cache, history capped at 60 points. |
| State after app restart | Working | `reconcile()` re-verifies each persisted PID against its command line before adopting; anything unverifiable is dropped to `stopped`. |
| File manager (list/read/write/create/delete) | Working | `resolveInsideServerDir()` rejects escapes (400). Traversal attempts tested (`../`, `..\\`, absolute paths) — none returned data and no file was written outside the folder. |
| File manager — upload/download | **Unverified** | Not exercised; no dedicated upload route was found, large files are refused above 5 MB for editing. |
| EULA consent | Working | `EulaConsentModal` + `acceptEula` flag; supervisor refuses to start without `eula=true`. |
| Engine/version selection | Partial | `parseEngineLabel()` prefers an explicit version; `/api/jars/engines/:engine` lists real versions from PaperMC (verified: latest is genuinely `26.3`). Install flow not executed end-to-end. |
| Backups (create/restore/delete/pin) | Partial | Real archive creation through the job queue with `sha256` verification and busy protection. Restore requires a configured archive name; **not exercised** in this pass. |
| Schedules | **Unverified** | Routes exist and are now authenticated; cron execution not inspected. |
| Plugins / modpacks marketplace | **Unverified** | Search/version/install routes exist; compatibility checks not inspected. Do not assume version compatibility claims are enforced. |
| Ports & forwarding | **Working — applies for real, but elevation not exercised here** | Rules persist to `.local-port-forwards.json`; a rule is `RECORDED` until an elevated `netsh` run has created the portproxy entry and firewall rule **and** the OS read-back matched, then it becomes `ACTIVE`. `FAILED` carries the reason. Cancelled or declined UAC is a refusal, never success. Apply/verify/revert are unit-tested with injected runners; the real netsh *write* was not run in this pass (it needs UAC approval). |
| Databases — engine config | Partial | `POST /api/database/configure-engine` swallows a failed MySQL connection into an `ok: true` response with an explanatory message. |
| Databases — credential check | **Broken → Fixed** | `SetupPanelGuideView` posted to `/api/database/verify-credentials`, which did not exist. Implemented: real MySQL `VERSION()` query, honest `502` on refusal. |
| Databases — schema inject | **Broken → Fixed** | `POST /api/database/inject-sql` did not exist, and the UI *faked success* on network error. Implemented: validates names, creates the databases plus the four panel tables, then verifies them against `information_schema`; the UI only shows success for a confirmed `ok`. |
| Operation jobs | Working | `GET /api/jobs`, `/jobs/:id`, `/jobs/:id/cancel`, scoped by actor. |
| Discord Access Settings + Test connection | Working | Super-Admin card; `POST /api/auth/discord/diagnostics` returns `ok` / `role_missing` / `not_a_member` / `reconnect_required` / `unavailable` / `not_configured`. |
| Overview / Console / Startup / Settings / Logs views | Partial | Render against real endpoints; only the console/live-state and registry paths were exercised. |

---

## 4. Database credential + schema endpoints (new)

* `POST /api/database/verify-credentials` — `validateSession`. Validates host and
  username before dialling out (400, not 502), then opens a real MySQL connection
  and returns the server version. MongoDB uses `tryConnectLiveMongo`. A refused
  connection is `502 { verified: false }`.
* `POST /api/database/inject-sql` — `validateSession`. Names are matched against
  `^[A-Za-z0-9_]{1,64}$`; each database gets `users`, `servers`,
  `server_backups`, `server_schedules` (MySQL mirror of the SQLite schema), and
  the result is confirmed against `information_schema` before `ok: true`.
  Partial success is `207` with the per-database error.

---

## 5. Renderer fixes

* `SetupPanelGuideView`: the credential check no longer sets "verified" in its
  `catch` block, and the schema step no longer reports success when the backend
  failed. Button/labels updated to say what actually happens ("Create Databases").
* `App.tsx`: the 45-second PaperMC poll no longer starts before sign-in — every
  endpoint requires a session now, so a signed-out interval only produced 401s.

### Port forwarding (rule store, then real apply)

* **Store:** `.local-port-forwards.json` in `APPDATA_DB_DIR` (next to
  `.local-install-config.json`), written atomically and re-read on boot. A
  corrupt or missing file yields an empty list instead of a boot failure. A rule
  saved as `APPLYING` (the process died mid-apply) comes back as `RECORDED`.
* **Validation** (`400` with a reason): both ports whole numbers 1–65535,
  `protocol` in `TCP | UDP | TCP/UDP`, `method` in the four offered engines,
  `internalIp` an IPv4 literal, `serviceName` trimmed to 120 chars. Invalid
  input writes nothing.
* **Endpoints** (`validateSession` + `requireAdvancedPanel` on all of them):
  * `GET /api/network/local-ports` — `forwards[]` with a fresh `liveProbe` of
    the local port.
  * `POST /api/network/forward` — upserts one rule per port pair (`replaced`
    flag). New rules have no mapping on the PC, so nothing claims otherwise.
  * `POST /api/network/forward/:port/apply` — the real thing: one **elevated**
    PowerShell runs `netsh interface portproxy` (delete-then-add, so re-apply is
    idempotent) and `netsh advfirewall firewall` (delete-then-add), then the
    backend reads the state back. `ACTIVE` only on a matching read-back;
    otherwise `FAILED` with the reason. `503` when elevation is switched off,
    `409` when the UAC prompt is declined, `501` off Windows.
  * `POST /api/network/forward/:port/verify` — re-reads netsh and downgrades a
    rule whose mapping vanished.
  * `POST /api/network/forward/:port/revert` — elevated delete of both entries;
    the rule drops to `RECORDED` only once they are actually gone.
  * `DELETE /api/network/forward/:port` — `404` when nothing matches; an
    `ACTIVE` rule is reverted first, and the record is kept if that fails, so
    the panel cannot forget an open port.
* **Command safety.** argv only, never a shell string: ports are integers,
  the bind address is a validated IPv4 literal, and the firewall rule name is
  derived from the port (`IS King Panel Forward <port>`). No request text reaches
  netsh or PowerShell.
* **Elevation.** The panel does not require running as Administrator: each
  apply/revert starts one hidden PowerShell via `-Verb RunAs`, so Windows shows
  its own UAC prompt. A decline is reported as a decline
  (`ELEVATION_DECLINED`) and changes nothing. `KINGPANEL_PORT_FORWARD_ELEVATION=off`
  disables the whole path (used by the test suite so CI never pops a prompt).
* **Renderer:** `NetworkPortsView` reads the backend list (no second React copy,
  no invented throughput) and shows the real probe plus `RECORDED / ACTIVE /
  FAILED` with the failure reason. `Apply` asks for confirmation and says Windows
  will request approval; `Verify` and `Revert` appear once a rule is active. The
  fabricated playit.gg / Cloudflare tunnel cards are gone — the view states that
  no tunnel client is installed.
* **Still not the panel's job:** router/NAT forwarding. On a machine behind NAT
  the local mapping is not enough, and the UI says so instead of implying it is
  reachable from the internet.

---

## 6. Tests

New: [test/server.integration.test.mjs](../test/server.integration.test.mjs) —
boots the **real** server (`tsx server.ts`) against a temp `APPDATA_DB_DIR` and a
temp install root, then drives it over HTTP with a cookie jar.

```bash
npm test          # node --test test/*.test.mjs
npx tsc --noEmit  # typecheck
npx vite build    # renderer build
```

Coverage (51 assertions across 10 suites):

| Area | What is asserted |
| --- | --- |
| Anonymous access | 20 previously-open endpoints return `401` |
| Auth lifecycle | register, login, wrong password, logout, cookie replay after logout |
| Sessions | list, `revoke-others`, self-revoke clears the cookie, cross-account revoke is `403`, no credential fields leak |
| Entitlement | plain account gets Simple Panel (`200`) and is refused Advanced-only APIs (`403 ADVANCED_PANEL_REQUIRED`) |
| Super Admin | `/api/auth/users` and `admin/update-user` are `403` for a regular account; the target password is unchanged |
| Filesystem | six traversal shapes rejected, legitimate read/write works, no write escapes the folder |
| Lifecycle honesty | missing jar / EULA refusal / unknown action / command on a stopped server are all `400`; `live-state` reports `stopped` |
| Database | missing fields → `400`; dead MySQL port → `502 verified:false`; invalid DB name rejected before connecting |
| Jobs | per-actor listing, unknown job cancel → `404` |
| Simple Panel regression | real folder appears with real state and port |
| Port forwarding (rules) | anonymous `401`, unverified account `403`, invalid port/protocol/IP/method `400` (and nothing written), valid rule stored as `RECORDED`, listed by the scan endpoint, apply without elevation `503 ELEVATION_DISABLED` → `FAILED`, verify never says `ACTIVE` unless the read-back matched, unknown delete `404`, **rule survives a full backend restart**, delete clears it from disk |
| Apply / revert logic ([port-forward-windows.test.mjs](../test/port-forward-windows.test.mjs)) | exact netsh argv (incl. `protocol=any` for TCP/UDP and no portproxy for UDP-only), invalid ports/addresses refused before a command exists, real netsh output parsing, declined UAC, failed add, missing log, timeout, **netsh "success" without a matching read-back → `VERIFY_FAILED`**, revert that leaves the mapping → `REVERT_FAILED` |
| Elevated-apply self-test | disposable-port selection skips taken/reserved/invalid values and returns `null` only when the range is exhausted, throwaway target maps loopback onto itself, cleanup commands name the exact rule; over HTTP: anonymous `401`, unentitled `403`, elevation off → `503 ELEVATION_DISABLED` with `proven:false`, one `apply` stage, a port in 49152-65535, and **no rule written to the store or the scan** |

Result of this run: **94 passed, 0 failed** (19 suites, ≈10 s).

---

## 7. Outstanding issues (not changed in this pass)

1. ~~**Port forwarding is cosmetic.**~~ **Done.** Rules persist, an elevated
   apply creates the real portproxy + firewall entries, and `ACTIVE` requires a
   matching read-back. **Not exercised end to end in this pass:** the actual
   elevated write needs someone to approve the UAC prompt, so the classify/verify
   logic is proven with injected runners (26 assertions) and the real netsh
   *read* path was run against this machine. The first real apply on a target PC
   is still unverified — press **Test elevated apply** (Network) once and approve
   the prompt: it applies a throwaway mapping on a free high port, verifies it,
   reverts it, and reports `PROVEN · CLEANED UP` or `NOT PROVEN`.
2. **Router/NAT forwarding is still manual.** `upnpc`/router admin is not driven
   by the panel; only the Windows-side mapping is automated.
3. **Schedules and plugin/modpacks flows were not verified.** Their routes are now
   authenticated, but execution and compatibility checks are unaudited.
4. **`configure-engine` reports `ok: true` on a failed connection.** The message
   explains the failure but the status code does not.
5. **Signed-in state is cached in `localStorage`** (`king_panel_auth_user`). With
   the new backend gating, a stale cache now degrades to 401s until
   `/api/account/access` reports `sessionExpired` and the app signs out. A boot-time
   session probe would make this immediate.
6. **No per-user server ownership.** The install root is a single shared directory;
   every authenticated account sees every server. This is a single-operator design,
   not a bug, but it means "server ownership checks" cannot exist until an owner
   field is added to the setup map.
7. **The LAN bind (`0.0.0.0`) remains.** Authentication is now enforced, but if the
   panel is not meant to be reachable from other machines, `127.0.0.1` would remove
   the attack surface entirely.
8. **The SSE route `/api/servers/:id/events` is unused** by the renderer, which
   polls instead. Keeping both is fine; deleting the poll in favour of SSE is a
   later optimisation.

---

## 8. Manual steps required

* Runtime credentials unchanged: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
  `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_ADVANCED_ROLE_ID` (or Panel
  Control → Discord Access Settings), `MONGODB_URI` if Mongo is used.
* Port forwarding: the **Windows** side (portproxy + inbound firewall rule) is
  applied by the panel after you approve a UAC prompt. Two things stay manual by
  design — (a) **router/NAT** forwarding must still be done on the router itself,
  and (b) the first apply needs someone at the keyboard to accept the elevation   prompt (or press **Test elevated apply** in Network → it applies and reverts a
   throwaway port once, proving the path without touching any rule). Set
   `KINGPANEL_PORT_FORWARD_ELEVATION=off` to keep the panel rules-only.
* To reach the Advanced Panel, the signed-in account must link Discord, be in the
  configured guild, and hold the configured role.
