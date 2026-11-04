# IS King Panel — Workflow Inventory

Developer-facing map of every workflow the panel implements: what it does, which
UI surface triggers it, which HTTP endpoint serves it, and where its state lives.

This is a **derived** document, not a design proposal. The route appendix between
the `BEGIN GENERATED` / `END GENERATED` markers is generated from
[server.ts](../server.ts) rather than typed by hand, and every endpoint named
below is checked to exist there.

```bash
npm run check:docs           # verify this doc against server.ts
npm run check:docs -- --fix  # regenerate the appendix table
```

The check runs in CI ([ci.yml](../.github/workflows/ci.yml)), so a route that is
renamed, added or moved to a different line fails the pull request instead of
leaving this inventory quietly wrong. Edit the prose freely; never hand-edit
inside the markers.

- Backend surface: **106 route definitions** — 63 `POST`, 36 `GET`, 7 `DELETE` (no `PUT`/`PATCH`).
- Renderer surface: **16 views** in [src/views](../src/views), **10 sections** in
  [src/components/simple](../src/components/simple), plus the gate/overlay components.
- Backend modules: [server/process-supervisor.ts](../server/process-supervisor.ts),
  [server/job-manager.ts](../server/job-manager.ts),
  [server/port-forward-windows.ts](../server/port-forward-windows.ts).
- Desktop shell: [electron-main.cjs](../electron-main.cjs) with 7 IPC channels.

Companion reading: [ADVANCED_PANEL_AUDIT.md](ADVANCED_PANEL_AUDIT.md) records the
access-control findings this document assumes.

---

## 1. Runtime shape

| Layer | File | Responsibility |
| --- | --- | --- |
| Desktop shell | [electron-main.cjs](../electron-main.cjs) | Single-instance lock, tray, window IPC, auto-updater, external-link handling, spawning the backend |
| Preload bridge | [electron-preload.cjs](../electron-preload.cjs) | Exposes only window controls to the renderer |
| Backend | [server.ts](../server.ts) → [server.cjs](../server.cjs) | Express app: every API, static/SPA serving, Vite middleware in dev |
| Controller | [process-supervisor.ts](../server/process-supervisor.ts) | Real `java` spawn, console parsing, history sampling, crash/exit detection, PID reconciliation |
| Long jobs | [job-manager.ts](../server/job-manager.ts) | Durable job rows: install, backup, restore, reinstall — cancellable, resumable across UI reloads |
| Port forwarding | [port-forward-windows.ts](../server/port-forward-windows.ts) | Windows firewall rules + `netsh interface portproxy`, elevation script, verification and revert |
| Renderer | [src/App.tsx](../src/App.tsx) | Simple Panel (default) and Advanced Panel (entitlement-gated) |

**Process wiring.** The shell spawns `server.cjs` with `PORT` and `APPDATA_DB_DIR`
(see [electron-main.cjs:311](../electron-main.cjs#L311)). When that variable is
absent the backend falls back to `<repo>/database`. Both the SQLite file and the
JSON mirrors resolve from that one directory, so which store is live depends
entirely on that variable — see §17.

---

## 2. Two panel modes

| Mode | Entry | Gating |
| --- | --- | --- |
| Simple Panel | default landing | session only |
| Advanced Panel | `handleEnterPanel(..., 'advanced')` | Discord guild membership + required role, checked server-side |

The renderer keeps the entitlement in [usePanelAccess.ts](../src/hooks/usePanelAccess.ts)
and the backend enforces the same decision with `requireAdvancedPanel`, applied to
**19 of the 106 routes**: port forwarding (2), marketplace install, panel process
controls (3), engine upgrade, database query/vacuum, log rotation, schedules (4
plus the 4 runtime-scoped schedule routes), and jar install.
Losing the entitlement while the Advanced Panel is open drops the user back to
Simple with a lock notice; the check is fail-closed.

---

## 3. Authentication, sessions and access

| Workflow | UI | API |
| --- | --- | --- |
| Sign in (id / username / email) | [AuthGateModal.tsx](../src/components/AuthGateModal.tsx) | `POST /api/auth/login` |
| Create / restore session | — | `POST /api/auth/session` |
| Sign out | header menu | `POST /api/auth/logout` |
| Register | gate sign-up | `POST /api/auth/register` |
| Request / consume password reset | gate reset flow | `POST /api/auth/password-reset-request`, `POST /api/auth/password-reset`, `POST /api/auth/reset-password` |
| Change password | [AccountSecurityPanel.tsx](../src/components/AccountSecurityPanel.tsx) | `POST /api/auth/change-password` |
| Session list / revoke | [SessionManagementPanel.tsx](../src/components/SessionManagementPanel.tsx) | `GET /api/auth/sessions`, `POST /api/auth/sessions/revoke`, `POST /api/auth/sessions/revoke-others` |
| OAuth sign-in (Discord, GitHub, Google) | provider buttons | `GET /api/auth/url/:provider`, `POST /api/auth/oauth-login` |
| Link / unlink a provider | [ProviderConnectionsPanel.tsx](../src/components/ProviderConnectionsPanel.tsx) | `GET /api/auth/providers`, `POST /api/auth/provider/link/:provider`, `POST /api/auth/provider/disconnect` |
| Discord bot verification | [DiscordBotGateModal.tsx](../src/components/DiscordBotGateModal.tsx) | `POST /api/auth/discord/verify-bot`, `POST /api/auth/discord/diagnostics`, `POST /api/auth/discord/leave-guild`, `POST /api/auth/discord/config` |
| Advanced-Panel entitlement | [DiscordAccessSettings.tsx](../src/components/DiscordAccessSettings.tsx) | `GET /api/account/access`, `POST /api/account/access/refresh` |
| Discord account link | account screen | `POST /api/account/discord/link/start` |
| Operator list | admin surface | `GET /api/auth/users` |
| Legacy folder attribution | [ServerOwnershipSettings.tsx](../src/components/ServerOwnershipSettings.tsx) | `GET /api/admin/server-ownership`, `POST /api/admin/server-ownership/assign` |

Passwords are stored by [server/password.ts](../server/password.ts) as
`scrypt$N$r$p$salt$key` (N=16384, r=8, p=1, 16-byte salt, 64-byte key). The login
handler still verifies the pre-migration bare SHA-256 hash — which used one salt
(`isking_salt_v48:`) for every account — and rewrites the row to scrypt on that
successful sign-in, so no existing account is locked out and every hash upgrades
on first use. A stored hash whose parameters fall outside the accepted ceilings
is treated as malformed and fails closed.

There is no fixed credential in the build. A fresh install generates a random
password for the bootstrap Super Admin (`kingplayz` / `SA-KINGPLAYZ-001`) and
appends it to `FIRST-RUN-CREDENTIALS.txt` next to the database; any installation
still carrying `KingPlayz#2026` or `kingpanel123` has that hash rotated on next
start and the replacement written to the same file. The file also collects
per-account recovery codes, which are not passwords.

---

## 4. First-run onboarding

Order as the UI enforces it:

1. **EULA consent** — [EulaConsentModal.tsx](../src/components/EulaConsentModal.tsx).
2. **Install root** — [LocalDiskFolderPickerModal.tsx](../src/components/LocalDiskFolderPickerModal.tsx);
   `GET /api/system/local-drives`, `POST /api/system/browse-folders`, `POST /api/panel/install-folder`.
3. **Server instance** — [ServerInstallModal.tsx](../src/components/ServerInstallModal.tsx);
   `POST /api/panel/install-server-instance` (engine, version, port), `POST /api/server-runtime/install-jar`.
4. **Guided setup** — [SetupPanelGuideView.tsx](../src/views/SetupPanelGuideView.tsx).

---

## 5. Server lifecycle

| Workflow | API | Notes |
| --- | --- | --- |
| Create instance / startup record | `GET/POST /api/server-runtime/setup` | `POST` stores the startup command, main file, JVM path, extra args, flags and git settings, plus the engine, version, RAM and port remembered so the jar can be reinstalled later; `GET` returns the startup subset for one server |
| Install / reinstall jar | `POST /api/server-runtime/install-jar`, `POST /api/server-runtime/reinstall`, `POST /api/engines/upgrade-server` | Runs as job kind `install` / `reinstall` |
| Start | `POST /api/server-runtime/power` (`action: 'start'`) | Self-heals a folder with no jar by installing the recorded engine first |
| Stop / kill / restart | same endpoint (`'stop'`, `'kill'`, `'restart'`) | Stop sends the graceful path; kill terminates the process tree |
| Live state | `GET /api/server-runtime/live-state`, `GET /api/server-runtime/container-state` | PID, uptime, heap, player count |
| Event stream | `GET /api/servers/:id/events` | Real SSE (`text/event-stream`); **no `EventSource` in `src/`** — the UI polls instead |
| Java detection | `GET /api/server-runtime/java-check` | Candidates + per-jar preference |
| Properties editor | `POST /api/server-runtime/server-settings` | Writes validated `server.properties` keys (port, MOTD, max players, difficulty, online-mode, view distance); write-only — raw rows are read through the file manager |
| Startup / JVM | [StartupJvmView.tsx](../src/views/StartupJvmView.tsx), `POST /api/panel/ram-sync` | Heap cap, flags, extra args; RAM changes are audit-logged |
| Delete server | `DELETE /api/server-runtime/server` | Removes registration and folder |

Supervision is real: readiness is derived from console output, not from a timer,
and a restarted backend adopts an already-running JVM by PID
([process-supervisor.ts](../server/process-supervisor.ts)).

---

## 6. Console, logs and telemetry

| Workflow | UI | API |
| --- | --- | --- |
| Console + send command | [ConsoleTelemetryView.tsx](../src/views/ConsoleTelemetryView.tsx), [SimpleConsoleSection.tsx](../src/components/simple/SimpleConsoleSection.tsx) | `POST /api/server-runtime/command` |
| Host telemetry | Overview / panel header | `GET /api/panel/telemetry` |
| Live log tail / rotate / append | [ServerLogsView.tsx](../src/views/ServerLogsView.tsx), [SimpleLogsSection.tsx](../src/components/simple/SimpleLogsSection.tsx) | `GET /api/logs/realtime`, `POST /api/logs/rotate`, `POST /api/logs/append` |

The three `…/realtime` endpoints are **snapshot polls** (JSON), not streams:
`/api/logs/realtime`, `/api/backups/realtime`, `/api/schedules/realtime`.

---

## 7. File manager

[FileManagerView.tsx](../src/views/FileManagerView.tsx),
[SimpleFilesSection.tsx](../src/components/simple/SimpleFilesSection.tsx).

List (`GET /api/server-runtime/files`), read (`GET /api/server-runtime/file`),
write (`POST /api/server-runtime/file`), create
(`POST /api/server-runtime/file-create`), delete
(`POST /api/server-runtime/file-delete`).

---

## 8. Backups and snapshots

[BackupsSnapshotsView.tsx](../src/views/BackupsSnapshotsView.tsx),
[SimpleBackupsSection.tsx](../src/components/simple/SimpleBackupsSection.tsx).

| Workflow | API | Job kind |
| --- | --- | --- |
| Create snapshot | `POST /api/backups/create`, `POST /api/server-runtime/backup-create` | `backup` |
| List | `GET /api/backups/realtime`, `GET /api/server-runtime/backups` | — |
| Restore | `POST /api/backups/restore`, `POST /api/server-runtime/backup-restore` | `restore` |
| Pin / delete | `POST /api/backups/pin`, `DELETE /api/backups/:id` | — |
| Delete runtime backup | `DELETE /api/server-runtime/backup` | — |

---

## 9. Schedules (cron)

[SchedulesCronView.tsx](../src/views/SchedulesCronView.tsx),
[SimpleSchedulesSection.tsx](../src/components/simple/SimpleSchedulesSection.tsx).

Create (`POST /api/schedules/create`), run now (`POST /api/schedules/run`), toggle
(`POST /api/schedules/toggle`), delete (`DELETE /api/schedules/:id`), list
(`GET /api/schedules/realtime`). The runtime-scoped variants
(`POST /api/server-runtime/schedule-create`, `POST /api/server-runtime/schedule-run`,
`POST /api/server-runtime/schedule-update`,
`DELETE /api/server-runtime/schedule/:id`, `GET /api/server-runtime/schedules`)
persist against a specific server folder.

---

## 10. Network and port forwarding

[NetworkPortsView.tsx](../src/views/NetworkPortsView.tsx),
[SimpleNetworkSection.tsx](../src/components/simple/SimpleNetworkSection.tsx).

- `GET /api/network/local-ports` — real listeners on the host.
- `POST /api/network/forward` — creates/updates one rule per port pair: firewall
  rule (`IS King Panel Forward <port>`) plus `netsh interface portproxy` for
  TCP-protocol forwards. Requires elevation; the elevated script runs with a
  timeout and its log is parsed back ([port-forward-windows.ts](../server/port-forward-windows.ts)).
- `DELETE /api/network/forward/:port` — reverts both rule types.
- Gated by `requireAdvancedPanel`. Covered by
  [test/port-forwards.test.mjs](../test/port-forwards.test.mjs) and
  [test/port-forward-windows.test.mjs](../test/port-forward-windows.test.mjs).

---

## 11. Databases

[DatabasesView.tsx](../src/views/DatabasesView.tsx),
[SimpleDatabaseSection.tsx](../src/components/simple/SimpleDatabaseSection.tsx).

| Workflow | API |
| --- | --- |
| Overview / realtime status | `GET /api/database/overview`, `GET /api/database/realtime-status` |
| Provision a per-server database | `POST /api/database/provision-server` |
| List / drop databases | `GET /api/database/server-databases`, `DELETE /api/database/server-database/:name` |
| Test credentials | `POST /api/database/verify-credentials` |
| Configure engine | `POST /api/database/configure-engine` |
| SQL console | `POST /api/database/query` |
| Administrative SQL | `POST /api/database/inject-sql` |
| Vacuum | `POST /api/database/vacuum` |
| Update a user row | `POST /api/database/admin/update-user` |
| Push everything to MongoDB | `POST /api/database/mongodb/push-all` |

Storage is SQLite in WAL mode; MySQL and MongoDB are optional probes/mirrors,
never the source of truth for accounts.

---

## 12. Engines and versions

| Workflow | API |
| --- | --- |
| Read the cached version check | `GET /api/engines/version-check` |
| Run a fresh check | `POST /api/engines/version-check/run` |
| Jar catalogue for an engine / version | `GET /api/jars/engines/:engine`, `GET /api/jars/engines/:engine/:version` |
| Upgrade a server | `POST /api/engines/upgrade-server` |

Engines wired to upstream APIs: Vanilla (Mojang piston), Paper and Folia and
Velocity (`fill.papermc.io`), Purpur, Fabric (Fabric meta), Spigot (legacy CDN).

---

## 13. Modpacks and plugins

[ModpacksPluginsView.tsx](../src/views/ModpacksPluginsView.tsx) — Modrinth-backed.

Search (`GET /api/marketplace/search`), versions for a project
(`GET /api/marketplace/versions/:idOrSlug`), install
(`POST /api/marketplace/install`, job kind `install`).

---

## 14. Panel control and system utilities

[PanelControlView.tsx](../src/views/PanelControlView.tsx).

| Workflow | API | Notes |
| --- | --- | --- |
| Set install root / create folders | `POST /api/panel/install-folder` | Optional EULA accept, subfolder creation |
| Create server instance | `POST /api/panel/install-server-instance` | Engine + version + port |
| Spawn a local worker | `POST /api/panel/spawn-local-worker` | Allocates a small resident process; advanced-panel gated |
| Profile sync | `POST /api/panel/profile-sync` | Updates the account record and its Mongo document |
| RAM sync | `POST /api/panel/ram-sync` | Writes a `RAM_ALLOC` audit entry |
| Host telemetry | `GET /api/panel/telemetry` | Memory/CPU sampling |
| Mojang skin lookup | `GET /api/panel/mojang/:username` | Resolves UUID + `mc-heads.net` avatar |
| Kill stray local PID | `POST /api/panel/kill-local-pid` | — |
| Kill a server | `POST /api/panel/server-kill` | — |
| App info | `GET /api/windows-app/info` | Version, paths, database location |

---

## 15. Job system

[JobProgressBar.tsx](../src/components/JobProgressBar.tsx) +
[job-manager.ts](../server/job-manager.ts).

Start a long operation (install / backup / restore / reinstall), poll it
(`GET /api/jobs/:id`), list all (`GET /api/jobs`), cancel
(`POST /api/jobs/:id/cancel`). Jobs are rows in SQLite, so they survive a UI
reload; a job interrupted by a panel exit is marked rather than left "running".

---

## 16. UI surface map

**Advanced views** — [src/views](../src/views):

| View | Workflow |
| --- | --- |
| [OverviewView](../src/views/OverviewView.tsx) | Dashboard: status, telemetry, quick actions |
| [ConsoleTelemetryView](../src/views/ConsoleTelemetryView.tsx) | Console I/O + live graphs |
| [ServerLogsView](../src/views/ServerLogsView.tsx) | Log browsing, rotation |
| [FileManagerView](../src/views/FileManagerView.tsx) | File CRUD |
| [BackupsSnapshotsView](../src/views/BackupsSnapshotsView.tsx) | Snapshots, restore, pin |
| [SchedulesCronView](../src/views/SchedulesCronView.tsx) | Cron jobs |
| [NetworkPortsView](../src/views/NetworkPortsView.tsx) | Listeners + port forwarding |
| [DatabasesView](../src/views/DatabasesView.tsx) | Database tooling |
| [ModpacksPluginsView](../src/views/ModpacksPluginsView.tsx) | Modrinth browse/install |
| [StartupJvmView](../src/views/StartupJvmView.tsx) | Engine, jar, JVM flags |
| [ServerSettingsView](../src/views/ServerSettingsView.tsx) | `server.properties` |
| [PanelControlView](../src/views/PanelControlView.tsx) | Install root, workers, sync utilities |
| [SetupPanelGuideView](../src/views/SetupPanelGuideView.tsx) | Guided first-run setup |
| [PrivacyPolicyView](../src/views/PrivacyPolicyView.tsx) / [TermsConditionsView](../src/views/TermsConditionsView.tsx) | Legal |
| [NotFound404View](../src/views/NotFound404View.tsx) | SPA fallback for unknown paths |

**Simple Panel** — [SimpleServerPanel.tsx](../src/components/SimpleServerPanel.tsx)
composes ten sections: header, console, files, backups, settings, startup, network,
schedules, logs, database.

**Overlays and gates:** [SimplePrePanel.tsx](../src/components/SimplePrePanel.tsx),
[AuthGateModal.tsx](../src/components/AuthGateModal.tsx),
[DiscordBotGateModal.tsx](../src/components/DiscordBotGateModal.tsx),
[EulaConsentModal.tsx](../src/components/EulaConsentModal.tsx),
[ServerInstallModal.tsx](../src/components/ServerInstallModal.tsx),
[DesktopCloseModal.tsx](../src/components/DesktopCloseModal.tsx),
[PanelErrorBoundary.tsx](../src/components/PanelErrorBoundary.tsx).

**Desktop shell workflows** — single-instance lock; window IPC
(`window:minimize`, `window:maximize`, `window:close`, `window:is-maximized`,
`window:is-visible`, `window:hide-to-tray`, `app:quit`); tray restore; auto-update
events; external links opened in the system browser.

---

## 17. State and storage

| Store | Path | Owner |
| --- | --- | --- |
| Users, sessions, servers, audits, backups, schedules, logs, engine checks, Discord tokens | `<dbDir>/isking_panel.sqlite` (WAL) | SQLite |
| Account mirror | `<stateDir>/.local-users-db.json` | Written back from SQLite on save |
| Operator profile | `<stateDir>/.local-operator-profile.json` | Backend |
| Runtime snapshot | `<stateDir>/server_runtime.json` | Backend |
| Discord config | `<stateDir>/.local-discord-config.json` | Backend |
| Install config, schedules mirror | `<stateDir>/.local-install-config.json`, `.panel-schedules.json` | Backend |

`<dbDir>` is `APPDATA_DB_DIR` when set, otherwise `<repo>/database`; `<stateDir>`
is the same directory when `APPDATA_DB_DIR` is set, otherwise the working directory.

**Packaged builds.** [electron-main.cjs](../electron-main.cjs) pins `userData` to
`%APPDATA%\IS King Panel` by value ([state-dirs.cjs](../state-dirs.cjs)), so
renaming the package (`name` is still `react-example`) cannot move the data, and
passes `<stateDir>/database` as `APPDATA_DB_DIR`. An explicit `--user-data-dir`
still wins, and such a run never inherits legacy data. On first start the backend
copies a pre-pin `%APPDATA%\react-example` installation across
([server/state-dir.ts](../server/state-dir.ts)): the source is snapshotted, the
database is copied only when the destination file is absent, the copy is verified
with `PRAGMA integrity_check`, and any failure leaves the source untouched and
stops the account layer from opening an empty store. The migration is idempotent
— a present destination is never overwritten.

**Schema handling.** `CREATE TABLE IF NOT EXISTS` never alters an existing table,
so the users table migrates itself at startup: missing columns are added with
`ALTER TABLE … ADD COLUMN`, values for the newly created columns are backfilled
from the JSON mirror, and the Super Admin flag is set for `kingplayz`. A users
query that still fails logs `[SQLite] users query failed, falling back to the JSON
mirror:` instead of silently switching stores.

**Server folder ownership.** `server_owners` ([server/ownership.ts](../server/ownership.ts))
records the creating account per folder, keyed case-insensitively. A folder with
no row — every folder that predates the table — is Super Admin only; it is never
auto-assigned to the account that signs in first. The Super Admin attributes one
explicitly through `POST /api/admin/server-ownership/assign`, which validates that
the folder sits directly under the install root, resolves the target account by id
or username, is idempotent, and records the change in the panel audit log.

---

## 18. Build, test and release

| Workflow | Command / file |
| --- | --- |
| Dev server (tsx + Vite) | `npm run dev` |
| Frontend build | `npm run build` |
| Backend bundle → `server.cjs` | `npm run build:backend` ([build-backend.mjs](../scripts/build-backend.mjs)) |
| Bundled backend runtime | `npm run runtime:fetch`, `npm run runtime:check` ([fetch-runtime.mjs](../scripts/fetch-runtime.mjs), pin in [runtime/runtime.json](../runtime/runtime.json)) |
| Typecheck | `npm run lint` |
| Tests | `npm test` (node test runner, [test/](../test)) |
| Tracked-data guard | `npm run check:data` ([check-tracked-data.mjs](../scripts/check-tracked-data.mjs)) |
| Windows installer | `npm run electron:build` ([build-release.mjs](../scripts/build-release.mjs); packaging config lives in the `build` block of [package.json](../package.json)) |
| Release artifact gate | `npm run check:release` ([release-assets.mjs](../scripts/release-assets.mjs), rules in [release-verify.mjs](../scripts/release-verify.mjs), packaged-data rules in [packaging-privacy.mjs](../scripts/packaging-privacy.mjs)) |
| Authenticode gate | `npm run verify:signing` ([verify-signatures.mjs](../scripts/verify-signatures.mjs), policy in [signing.mjs](../scripts/signing.mjs)) |
| Upgrade fixtures (both sides) | `npm run fixtures:upgrade -- --from-version 1.0.1 [--cache]` ([make-upgrade-fixtures.mjs](../scripts/make-upgrade-fixtures.mjs), cache rules in [fixture-cache.mjs](../scripts/fixture-cache.mjs)) |
| Upgrade verification (per-user) | `npm run verify:upgrade` ([verify-installed-upgrade.mjs](../scripts/verify-installed-upgrade.mjs)) |
| Per-machine install check | `npm run verify:install-machine` ([verify-machine-install.mjs](../scripts/verify-machine-install.mjs), rules in [install-config.mjs](../scripts/install-config.mjs)) |
| CI on PRs and `master` | [ci.yml](../.github/workflows/ci.yml) |
| Tagged release | [release.yml](../.github/workflows/release.yml) |

A release runs in two jobs on GitHub Actions ([release.yml](../.github/workflows/release.yml)):
`build` (tag preflight, tests, typecheck, docs/data checks, runtime fetch + verify,
installer build, artifact + packaged-runtime verification) on a read-only token, then
`publish` (`contents: write` only here) which re-verifies the downloaded artifacts,
refuses to touch an already-published or partially published release, uploads only the
three verified filenames, and re-reads the published assets and the anonymous update
feed. The tag must already equal the `package.json` version; nothing rewrites versions.

`scripts/release-verify.mjs` is the single definition of a valid release — tag/version
agreement, artifact presence and a complete set, `latest.yml` path/version/size/SHA-512,
blockmap integrity, stray artifacts, and (with `--runtime`) the pinned runtime outside
the asar. The build and the publish step both call it, so the gate cannot drift.

**Packaged data.** An installer must contain the application and nothing about the
machine that built it. `build.files` used to include `database/**` and `extraResources`
copied the same directory in again, which shipped the developer's SQLite database,
account list and password hashes inside every locally built installer. Neither path is
needed: a packaged app keeps its state in `%APPDATA%\IS King Panel\database`
(`APPDATA_DB_DIR`, set by `electron-main.cjs`) and creates the schema on first launch.

`npm run check:release` (`--privacy`, and `electron:build` before it publishes anything)
now inspects the packaged tree in [packaging-privacy.mjs](../scripts/packaging-privacy.mjs):

- `resources/` may contain only `app.asar`, `app.asar.unpacked`, `app-update.yml`,
  `elevate.exe` and `runtime`. `database/`, `KingServers/`, logs and anything else fail
  the build by name.
- Inside `app.asar`, payload entries must match an explicit allowlist (`dist/`,
  `node_modules/`, `src/`, the main-process scripts, `package.json`). The archive is read
  with [asar-entries.mjs](../scripts/asar-entries.mjs) — no extra dependency — and every
  payload file's contents are read, so a renamed file is still a file.
- Any SQLite database anywhere in the tree is rejected, whatever it is called: the check
  sniffs the format magic, opens it read-only and reports row counts per table
  (`users=5`), never values.
- State-looking JSON/text files are scanned for password hashes, OAuth tokens, client
  secrets, recovery codes and `KEY=value` secrets. `server.cjs` is never scanned for
  prose — it mentions `password_hash` in its schema, and a gate that cries wolf is ignored.

A migration or schema file as SQL text is ordinary payload; a SQLite binary is not.

**Clean release build.** Nothing reads the developer's checkout state or `%APPDATA%`:

1. `git clone` (or `git worktree add`) the release commit and `npm ci` from the lockfile.
2. `npm run runtime:fetch` — verifies the pinned Node 22.23.1 download against
   `runtime/runtime.json` (the build does this itself; running it first shows failures early).
3. `npm run lint && npm test && npm run check:docs && npm run check:data`.
4. `npm run electron:build` — backend bundle, UI build, pinned runtime, NSIS packaging,
   then the runtime, privacy, artifact, blockmap and signature checks.
5. `npm run check:release` — re-runs the same gate over the finished artifacts.
   Add `CSC_LINK`/`CSC_KEY_PASSWORD` (and `ISK_REQUIRE_SIGNING=1`) for a signed build.

`database/` may stay in a checkout; the build no longer reads or copies it. A build run
with the directory renamed away produces the same installer contents.

**Upgrade fixtures.** `verify:upgrade` needs two installers, and both are generated —
neither is hand-assembled:

```
npm run fixtures:upgrade -- --from-version 1.0.1   # .tmp/e2e/v1.0.1 and .tmp/e2e/v1.0.2
npm run verify:upgrade                            # --from .tmp/e2e/v1.0.1 --to .tmp/e2e/v1.0.2
```

The generator packages the current tree with `extraMetadata.version` (so `package.json`
is not rewritten), `nsis.perMachine=false` and a generic feed pointing at the harness's
`127.0.0.1:8899`. It records the commit, config and installer hash in `fixture.json` per
side, and refuses a version that is equal to or newer than the candidate.

The candidate is a *fixture* rather than `dist_electron` because the release installer
is per-machine (`nsis.perMachine: true`) and cannot be installed silently without an
elevation prompt, which the harness never triggers. The upgrade path is therefore
exercised with the same code packaged per-user; the per-machine install directory and
the UAC prompt are not covered by it.

The harness installs and runs everything with `APPDATA` and `LOCALAPPDATA` redirected
into `.tmp/upgrade-e2e`, kills only processes whose executable sits inside its own
install directory (so a panel the developer has open is left alone), and refuses to
start if any directory it owns resolves inside the real profile.

The test deletes and reinstalls only its own directory under `.tmp/upgrade-e2e`; nothing
outside that tree is read, moved or removed. Each run installs into a fresh
`.tmp/upgrade-e2e/run-<stamp>/install` directory, because an NSIS uninstaller copies
itself to `%TEMP%` and keeps deleting after its launcher has exited — a fixed path let a
late helper from an earlier run delete the files of a fresh install. Old run directories
are cleared at the start of the next run, and an uninstall registry entry that points
into that tree while its uninstaller is gone is removed, so Settings never lists a panel
that is not installed. At the end the run uninstalls its own copy with the uninstaller
the install produced (pass `--keep-installed` to inspect the installed build instead).

**Installation modes.** The release installer is per-machine (`nsis.perMachine: true`):
it writes to `%ProgramFiles%\IS King Panel`, registers its uninstaller under HKLM, and
creates shortcuts for all users. It therefore needs an administrator. `verify:upgrade`
deliberately uses per-user fixtures instead, so it can run unprivileged — the two modes
are tested separately and keep their state in different directories.

`npm run verify:install-machine` is the per-machine side:

```
npm run verify:install-machine                       # read-only preflight (default)
npm run verify:install-machine -- --run --confirm=per-machine-install   # from an elevated terminal
```

Rules it follows, because it touches a real machine:

- It never elevates. Unelevated, the preflight exits 2 and says to open an elevated
  terminal; accepting a UAC prompt is the operator's decision, not the harness's.
- `--run` requires `--confirm=per-machine-install`. Nothing is installed, uninstalled or
  registered without it.
- A non-empty install directory is reported, never removed — that could be an app the
  user still runs. Only an *empty* leftover directory is offered for cleanup, with the
  `rmdir` command that needs administrator rights.
- The application runs with `APPDATA` redirected into `.tmp/machine-install`, so the
  developer's own profile is never read or written while the per-user data location is
  still verified (the state directory must resolve inside `%APPDATA%`, never inside the
  install directory).
- It checks, in order: install, executable present, version, launch, backend up, bundled
  runtime in use, data location, uninstall, **user data still present**, reinstall. With
  `--update-installer <path>` it also updates, and a *failed* update must leave the
  previous build installed, launchable and with its data intact.

The per-machine result is real Windows evidence only when it was actually run on a
machine or VM (Windows 10 and 11, both as an administrator). The mocked tests in
[test/install-modes.test.mjs](../test/install-modes.test.mjs) cover the logic, not trust
in the installer.

**Fixture cache.** `npm run fixtures:upgrade -- --cache` reuses a fixture only when
everything that determines its bytes still matches: source digest (the build inputs,
excluding `dist/`, `dist_electron/`, `.tmp/`, `database/`), the generated builder
config, the runtime pin in `runtime/runtime.json`, the electron-builder version, and the
fixture's own installer size and SHA-256. Missing `fixture.json`, a missing `latest.yml`,
a different version, or any changed digest rebuilds — and prints why. A dirty working
tree also rebuilds unless `--allow-dirty` is passed. `--force` rebuilds regardless;
`--clear-cache` deletes generated fixtures (only directories matching `v<semver>` that
contain a `fixture.json`). The plain command still does a clean build.

**Signing.** Release builds are signed with an Authenticode certificate supplied only
through `CSC_LINK` / `CSC_KEY_PASSWORD` (never committed, never printed).
electron-builder signs the application executable, the NSIS uninstaller and the
installer; `scripts/after-pack.cjs` checks the bundled `runtime/node.exe` *before* the
installer is compressed. That binary keeps its upstream OpenJS Foundation signature —
re-signing it would discard the vendor's and claim authorship we do not have — so it is
verified against the publisher pinned in `runtime/runtime.json` instead.
`ISK_REQUIRE_SIGNING=1` (set by the tag workflow) turns warnings into failures: an
unsigned, untrusted, untimestamped or differently-signed executable stops the release
before publication, and `signtool verify /pa /all` must agree with
`Get-AuthenticodeSignature`. A local build without a certificate stays unsigned and
says so (`[signing] … this build is UNSIGNED`). Two providers are supported (`ISK_SIGN_PROVIDER`): `esigner` for SSL.com's cloud signer, which
is the only route that works on a hosted runner now that publicly trusted keys cannot be
exported, and `pfx` for a self-hosted signer. Signing is SHA-256 only, and the certificate
identity is pinned in `package.json` → `iskSigning.expectedPublisher`: the release gate, the
packaged `app-update.yml` and the running updater all refuse anything else. The bundled
`resources/runtime/node.exe` is excluded from signing (`win.signExts`) so it keeps the
OpenJS Foundation signature instead of ours. The NSIS uninstaller
exists only after an install, so it is verified with `npm run verify:signing -- --installed
"C:\Program Files\IS King Panel"`.

Procurement, credential setup, rotation and recovery live in
[CODE_SIGNING_RUNBOOK.md](CODE_SIGNING_RUNBOOK.md); the audit and the Phase 1.3.5 remediation
are recorded in [PHASE_1_3_4_SIGNING_READINESS.md](PHASE_1_3_4_SIGNING_READINESS.md).

The installer carries its own Node runtime: the backend needs `node:sqlite`
(Node ≥ 22.5) and Electron 31 ships Node 20.18, so `runtime/runtime.json` pins
Node 22.23.1 with the SHA-256 published by nodejs.org, `npm run electron:build`
fetches it and refuses any mismatched download, and the release verifies that the
packaged `resources/runtime/node.exe` is that exact binary and loads
`node:sqlite`. [runtime-resolver.cjs](../runtime-resolver.cjs) uses a packaged
build's bundled runtime only — plus an explicit `ISK_NODE_PATH` override — and
never a PATH or system installation; when it is missing, startup reports an
incomplete installation and no backend is started.

---

## 19. Known gaps

- `GET /api/servers/:id/events` is a working SSE stream, but the renderer polls
  instead; no `EventSource` exists in `src/`.
- The `…/realtime` endpoints are snapshots; nothing streams pushes for logs,
  backups or schedules.
- Port forwarding needs an elevated Windows session and can legitimately fail on
  machines where the elevation prompt is dismissed; the route reports that rather
  than pretending success.
- Advanced-Panel routes are only as strong as the Discord entitlement check; it is
  fail-closed, so an API outage locks the Advanced Panel rather than opening it.
- Per-machine installation has a harness (`npm run verify:install-machine`) but has not
  been run as an administrator on Windows 10 or 11 yet. Its preflight, the mocked
  sequence tests and the per-user upgrade gate pass; those do not prove the per-machine
  installer. [Phase 1.3.3](PHASE_1_3_3_INSTALL_VALIDATION.md) tracks the outstanding run:
  every platform row there is `NOT TESTED`, so the release gate stays closed.
- An earlier probe left an **empty** `C:\Program Files\IS King Panel` on the development
  machine. It holds no files and no registry entry, and removing it needs an elevated
  shell: `rmdir "C:\Program Files\IS King Panel"`.
- Signing is implemented but unproven: no certificate exists, and the updater has not been
  exercised against a signed installer. The eSigner adapter has run only against the vendor
  sandbox — SHA-256, timestamped, and refused by our gate because that chain ends in a
  development root ([Phase 1.3.6](PHASE_1_3_6_CERTIFICATE_PROCUREMENT.md) §9). `iskSigning.expectedPublisher`
  is empty, so a release build fails closed until the purchased certificate's CN is recorded there.
  The remaining gaps are listed in
  [PHASE_1_3_4_SIGNING_READINESS.md](PHASE_1_3_4_SIGNING_READINESS.md) §9.

---

## Appendix A — every route

<!-- BEGIN GENERATED: routes -->
| Method | Path | Defined at |
| --- | --- | --- |
| GET | `*` | [server.ts:11130](../server.ts#L11130) |
| GET | `/api/account/access` | [server.ts:2615](../server.ts#L2615) |
| POST | `/api/account/access/refresh` | [server.ts:2635](../server.ts#L2635) |
| POST | `/api/account/discord/link/start` | [server.ts:3536](../server.ts#L3536) |
| GET | `/api/admin/server-ownership` | [server.ts:2779](../server.ts#L2779) |
| POST | `/api/admin/server-ownership/assign` | [server.ts:2823](../server.ts#L2823) |
| POST | `/api/auth/change-password` | [server.ts:3322](../server.ts#L3322) |
| POST | `/api/auth/discord/config` | [server.ts:3709](../server.ts#L3709) |
| POST | `/api/auth/discord/diagnostics` | [server.ts:3744](../server.ts#L3744) |
| POST | `/api/auth/discord/leave-guild` | [server.ts:3664](../server.ts#L3664) |
| POST | `/api/auth/discord/verify-bot` | [server.ts:3598](../server.ts#L3598) |
| POST | `/api/auth/login` | [server.ts:3072](../server.ts#L3072) |
| POST | `/api/auth/logout` | [server.ts:3857](../server.ts#L3857) |
| POST | `/api/auth/oauth-login` | [server.ts:3419](../server.ts#L3419) |
| POST | `/api/auth/password-reset` | [server.ts:3274](../server.ts#L3274) |
| POST | `/api/auth/password-reset-request` | [server.ts:3228](../server.ts#L3228) |
| POST | `/api/auth/provider/disconnect` | [server.ts:4184](../server.ts#L4184) |
| POST | `/api/auth/provider/link/:provider` | [server.ts:4249](../server.ts#L4249) |
| GET | `/api/auth/providers` | [server.ts:4085](../server.ts#L4085) |
| POST | `/api/auth/register` | [server.ts:2895](../server.ts#L2895) |
| POST | `/api/auth/reset-password` | [server.ts:3977](../server.ts#L3977) |
| POST | `/api/auth/session` | [server.ts:3852](../server.ts#L3852) |
| GET | `/api/auth/sessions` | [server.ts:3889](../server.ts#L3889) |
| POST | `/api/auth/sessions/revoke` | [server.ts:3916](../server.ts#L3916) |
| POST | `/api/auth/sessions/revoke-others` | [server.ts:3944](../server.ts#L3944) |
| GET | `/api/auth/url/:provider` | [server.ts:605](../server.ts#L605) |
| GET | `/api/auth/users` | [server.ts:2727](../server.ts#L2727) |
| DELETE | `/api/backups/:id` | [server.ts:8795](../server.ts#L8795) |
| POST | `/api/backups/create` | [server.ts:8676](../server.ts#L8676) |
| POST | `/api/backups/pin` | [server.ts:8729](../server.ts#L8729) |
| GET | `/api/backups/realtime` | [server.ts:8624](../server.ts#L8624) |
| POST | `/api/backups/restore` | [server.ts:8744](../server.ts#L8744) |
| POST | `/api/database/admin/update-user` | [server.ts:8115](../server.ts#L8115) |
| POST | `/api/database/configure-engine` | [server.ts:9128](../server.ts#L9128) |
| POST | `/api/database/inject-sql` | [server.ts:7832](../server.ts#L7832) |
| POST | `/api/database/mongodb/push-all` | [server.ts:9207](../server.ts#L9207) |
| GET | `/api/database/overview` | [server.ts:7965](../server.ts#L7965) |
| POST | `/api/database/provision-server` | [server.ts:11006](../server.ts#L11006) |
| POST | `/api/database/query` | [server.ts:8040](../server.ts#L8040) |
| GET | `/api/database/realtime-status` | [server.ts:9040](../server.ts#L9040) |
| DELETE | `/api/database/server-database/:name` | [server.ts:11069](../server.ts#L11069) |
| GET | `/api/database/server-databases` | [server.ts:10961](../server.ts#L10961) |
| POST | `/api/database/vacuum` | [server.ts:8101](../server.ts#L8101) |
| POST | `/api/database/verify-credentials` | [server.ts:7759](../server.ts#L7759) |
| POST | `/api/engines/upgrade-server` | [server.ts:7589](../server.ts#L7589) |
| GET | `/api/engines/version-check` | [server.ts:7512](../server.ts#L7512) |
| POST | `/api/engines/version-check/run` | [server.ts:7535](../server.ts#L7535) |
| GET | `/api/jars/engines/:engine` | [server.ts:4649](../server.ts#L4649) |
| GET | `/api/jars/engines/:engine/:version` | [server.ts:4738](../server.ts#L4738) |
| GET | `/api/jobs` | [server.ts:2688](../server.ts#L2688) |
| GET | `/api/jobs/:id` | [server.ts:2699](../server.ts#L2699) |
| POST | `/api/jobs/:id/cancel` | [server.ts:2709](../server.ts#L2709) |
| POST | `/api/logs/append` | [server.ts:8456](../server.ts#L8456) |
| GET | `/api/logs/realtime` | [server.ts:8395](../server.ts#L8395) |
| POST | `/api/logs/rotate` | [server.ts:8480](../server.ts#L8480) |
| POST | `/api/marketplace/install` | [server.ts:4544](../server.ts#L4544) |
| GET | `/api/marketplace/search` | [server.ts:4387](../server.ts#L4387) |
| GET | `/api/marketplace/versions/:idOrSlug` | [server.ts:4483](../server.ts#L4483) |
| POST | `/api/network/forward` | [server.ts:5607](../server.ts#L5607) |
| DELETE | `/api/network/forward/:port` | [server.ts:5677](../server.ts#L5677) |
| GET | `/api/network/local-ports` | [server.ts:5459](../server.ts#L5459) |
| POST | `/api/panel/install-folder` | [server.ts:6926](../server.ts#L6926) |
| POST | `/api/panel/install-server-instance` | [server.ts:7005](../server.ts#L7005) |
| POST | `/api/panel/kill-local-pid` | [server.ts:6727](../server.ts#L6727) |
| GET | `/api/panel/mojang/:username` | [server.ts:6814](../server.ts#L6814) |
| POST | `/api/panel/profile-sync` | [server.ts:6864](../server.ts#L6864) |
| POST | `/api/panel/ram-sync` | [server.ts:6763](../server.ts#L6763) |
| POST | `/api/panel/server-kill` | [server.ts:6785](../server.ts#L6785) |
| POST | `/api/panel/spawn-local-worker` | [server.ts:6681](../server.ts#L6681) |
| GET | `/api/panel/telemetry` | [server.ts:6485](../server.ts#L6485) |
| DELETE | `/api/schedules/:id` | [server.ts:9019](../server.ts#L9019) |
| POST | `/api/schedules/create` | [server.ts:8928](../server.ts#L8928) |
| GET | `/api/schedules/realtime` | [server.ts:8886](../server.ts#L8886) |
| POST | `/api/schedules/run` | [server.ts:8974](../server.ts#L8974) |
| POST | `/api/schedules/toggle` | [server.ts:8999](../server.ts#L8999) |
| DELETE | `/api/server-runtime/backup` | [server.ts:10506](../server.ts#L10506) |
| POST | `/api/server-runtime/backup-create` | [server.ts:10415](../server.ts#L10415) |
| POST | `/api/server-runtime/backup-restore` | [server.ts:10456](../server.ts#L10456) |
| GET | `/api/server-runtime/backups` | [server.ts:10268](../server.ts#L10268) |
| GET | `/api/server-runtime/changelog` | [server.ts:10237](../server.ts#L10237) |
| POST | `/api/server-runtime/command` | [server.ts:9570](../server.ts#L9570) |
| GET | `/api/server-runtime/container-state` | [server.ts:10186](../server.ts#L10186) |
| GET | `/api/server-runtime/file` | [server.ts:10015](../server.ts#L10015) |
| POST | `/api/server-runtime/file` | [server.ts:10048](../server.ts#L10048) |
| POST | `/api/server-runtime/file-create` | [server.ts:10069](../server.ts#L10069) |
| POST | `/api/server-runtime/file-delete` | [server.ts:10099](../server.ts#L10099) |
| GET | `/api/server-runtime/files` | [server.ts:9970](../server.ts#L9970) |
| POST | `/api/server-runtime/install-jar` | [server.ts:9674](../server.ts#L9674) |
| GET | `/api/server-runtime/java-check` | [server.ts:10125](../server.ts#L10125) |
| GET | `/api/server-runtime/live-state` | [server.ts:9894](../server.ts#L9894) |
| POST | `/api/server-runtime/power` | [server.ts:9498](../server.ts#L9498) |
| POST | `/api/server-runtime/reinstall` | [server.ts:10527](../server.ts#L10527) |
| POST | `/api/server-runtime/schedule-create` | [server.ts:10743](../server.ts#L10743) |
| POST | `/api/server-runtime/schedule-run` | [server.ts:10803](../server.ts#L10803) |
| POST | `/api/server-runtime/schedule-update` | [server.ts:10782](../server.ts#L10782) |
| DELETE | `/api/server-runtime/schedule/:id` | [server.ts:10825](../server.ts#L10825) |
| GET | `/api/server-runtime/schedules` | [server.ts:10735](../server.ts#L10735) |
| DELETE | `/api/server-runtime/server` | [server.ts:9766](../server.ts#L9766) |
| POST | `/api/server-runtime/server-settings` | [server.ts:10864](../server.ts#L10864) |
| GET | `/api/server-runtime/setup` | [server.ts:9587](../server.ts#L9587) |
| POST | `/api/server-runtime/setup` | [server.ts:9621](../server.ts#L9621) |
| GET | `/api/servers` | [server.ts:9416](../server.ts#L9416) |
| GET | `/api/servers/:id/events` | [server.ts:9466](../server.ts#L9466) |
| POST | `/api/system/browse-folders` | [server.ts:5364](../server.ts#L5364) |
| GET | `/api/system/local-drives` | [server.ts:5272](../server.ts#L5272) |
| GET | `/api/windows-app/info` | [server.ts:8165](../server.ts#L8165) |
<!-- END GENERATED: routes -->
