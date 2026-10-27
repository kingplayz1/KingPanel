# IS King Panel — Multi-Game Server Engine (Milestone 1)

Decisions taken: **hybrid runtime**, **local Windows first**, **Minecraft Java first**.
This document maps the architecture to the files that actually exist in this repository today.

## 1. Where things live now

| Concern | Real location today | Notes |
| --- | --- | --- |
| Express backend | `server.ts` (~7.2k lines, single file) | All routes, setup map, SQLite, auth, supervisor wiring |
| Process lifecycle | `server/process-supervisor.ts` | `ManagedServer`, start/stop/kill, console ring buffer, state machine (`online`, `starting`, `crashed`, …) |
| Setup / engine metadata | `.server-setup.json` map written by `loadSetupMap()` / `saveSetupMap()` in `server.ts` | Per-folder engine, version, port, RAM, javaPath |
| Server folders | `resolveRuntimeDir()` + `<installRoot>/KingServers/<ServerName>` | One folder per instance, path-validated with `resolveInsideServerDir()` |
| Backups | `/api/server-runtime/backup*` + archives in `<server>/backups` | tar.zst, SHA-256 recorded |
| Desktop shell | `electron-main.cjs`, `electron-preload.cjs` | Window, update, IPC |
| React UI | `src/App.tsx`, `src/views/*`, `src/components/*` | Advanced panel + Simple panel (`src/components/SimpleServerPanel.tsx`) |
| Simple panel sections | `src/components/simple/*` | Console, Files, Database, Schedules, Backups, Network, Startup, Settings, Logs |

There is **no** Docker driver, job queue, template registry, or multi-game abstraction yet. Minecraft Java (Paper/Purpur/Folia/Velocity/Waterfall/Fabric/Vanilla) is the only supported game and is handled directly by `process-supervisor.ts`.

## 2. Target architecture (mapped, not aspirational)

```
electron-main.cjs ──► server.ts (Express, 127.0.0.1)
                         ├── server-manager/           (new)
                         │     ├── server.service.ts   registry + validation
                         │     ├── lifecycle.service.ts jobs, state transitions
                         │     └── port.service.ts      allocation / conflict
                         ├── runtimes/                 (new)
                         │     ├── runtime.interface.ts
                         │     ├── native/native.driver.ts   (wraps process-supervisor)
                         │     └── docker/docker.driver.ts   (phase E)
                         ├── game-templates/           (new)
                         │     ├── template.schema.ts
                         │     └── minecraft-java.template.ts
                         └── existing routes kept intact
React (src/) ──► Simple + Advanced panels, both reading the same API
```

The existing `process-supervisor.ts` becomes the implementation behind `native.driver.ts` — it already has the state machine, console capture and crash reporting we need. It should not be rewritten, only wrapped.

## 3. Runtime contract (Phase B/C deliverable)

```ts
export type RuntimeKind = 'native' | 'docker';

export type ServerState =
  | 'created' | 'installing' | 'stopped' | 'starting'
  | 'running' | 'stopping' | 'failed' | 'deleting';

export interface ServerRuntime {
  readonly kind: RuntimeKind;
  create(serverId: string): Promise<void>;
  install(serverId: string): Promise<void>;
  start(serverId: string): Promise<void>;
  stop(serverId: string): Promise<void>;
  restart(serverId: string): Promise<void>;
  getState(serverId: string): Promise<ServerState>;
  getMetrics(serverId: string): Promise<ServerMetrics>;
  deleteRuntime(serverId: string): Promise<void>;
}
```

Rules:

- Long operations (`install`, `start`, `stop`) return a **job id**, not a held HTTP request.
- The UI must show which runtime an instance uses; a native process is not a container.
- Game-specific commands (`stop`, `save-all`) belong to the game adapter, not the driver.

## 4. Data model additions

Keep the existing SQLite database for auth/session and Mongo for profile data. Add a separate
`server_engine.sqlite` (or new tables in the existing DB if migrations allow):

- `servers` — id, owner, name, game_id, template_id, template_version, runtime_kind, state, data_path
- `server_configs` — server_id, config_json, config_version
- `server_runtime_instances` — runtime reference, desired_state, last_observed_state
- `server_ports` — host_port, protocol, purpose (unique constraint)
- `jobs` — type, state, progress, error_code
- `server_events` — audit trail

Today the equivalent data lives in `.server-setup.json` + the folder layout. Migration should import
those records rather than start empty.

## 5. API surface (added alongside existing routes)

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/games` | Supported games/templates |
| POST | `/api/servers` | Create (validated template + runtime + port) |
| POST | `/api/servers/:id/install` | Queue install job → `202` |
| POST | `/api/servers/:id/start` \| `/stop` \| `/restart` | Queue lifecycle job |
| GET | `/api/servers/:id/metrics` | Same numbers the Simple panel already polls |
| GET | `/api/jobs/:jobId` | Job progress |
| DELETE | `/api/servers/:id` | Explicit delete, data removal is separate |

Existing `/api/server-runtime/*` routes stay as the native driver's implementation and can be kept
as internal endpoints once `/api/servers/:id/*` exists.

## 6. Phases

- **A — Baseline (done for this repo):** typecheck (`npx tsc --noEmit`) and `vite build` pass; panel runs on `:3000`; real file/settings/startup data verified against disk.
- **B — Registry + templates:** add `server-manager/` and `game-templates/`, expose `/api/games`, keep `resolveRuntimeDir()` as the storage authority.
- **C — Jobs + lifecycle:** wrap `process-supervisor.ts` in `native.driver.ts`; add `jobs` table, `202` responses, idempotent stop, startup reconciliation.
- **D — Native Minecraft template:** formalise the current Paper/Vanilla install path as `minecraft-java.template.ts` (Java detection, EULA, jar install, port).
- **E — Docker driver:** Docker Engine detection, pinned images, per-server data mount, port mapping, resource limits; Docker is optional.
- **F — Multi-game:** add a second template (Rust via SteamCMD) only after install + lifecycle tests pass.
- **G — Packaging:** verify packaged Electron build, data outside build dirs, crash recovery, uninstall behaviour.

## 7. Security invariants to keep

- Bind the API to loopback; every management route behind the existing session check.
- `spawn()` with an executable + argument array; never `exec()` a templated string.
- File APIs stay behind `resolveInsideServerDir()` (already enforced in `server.ts`).
- Docker daemon local-only; no privileged containers; no host-root mounts.
- Never trust a client-supplied path, image name, or port without server-side validation.
