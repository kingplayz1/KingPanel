# Bundled Node runtime

The packaged app runs its backend (`server.cjs`) on a Node runtime, because the
backend opens SQLite through `node:sqlite` and needs **Node 22.5 or newer**.
Electron 31 carries Node 20.18, where that module throws, so an installed copy
ships its own runtime instead of borrowing one from the machine.

## What ships

| File | In git | Contents |
| --- | --- | --- |
| `runtime.json` | yes | The pin: version, architecture, download URL and SHA-256. |
| `node.exe` | **no** | Windows x64 Node, fetched and verified at build time. |
| `LICENSE` | **no** | Node.js licence and third-party notices, fetched with the binary. |

`runtime.json` is committed so the version and checksum are reviewable; the
~87 MB binary is not, and is rebuilt from the pin on demand.

## Current pin

- **Node 22.23.1**, `win-x64`
- Source: `https://nodejs.org/dist/v22.23.1/win-x64/node.exe`
- SHA-256: `f8d162c0641dcee512132f3bcf8a68169c7ecb852efd8e1a46c9fec5a0f469ed`
  (the value published in `https://nodejs.org/dist/v22.23.1/SHASUMS256.txt`)
- Licence: `https://raw.githubusercontent.com/nodejs/node/v22.23.1/LICENSE`
  (nodejs.org does not serve `LICENSE` under `dist/`), pinned by its own hash.

## Fetching it

```bash
npm run runtime:fetch     # download if absent or wrong, then verify
npm run runtime:check     # verify only; exits 1 when absent or mismatched
```

`npm run electron:build` runs the fetch as its first packaging step and fails the
release if anything does not match: the download only becomes `runtime/node.exe`
after its SHA-256 matches the pin, and the binary must then report the pinned
version and successfully `require('node:sqlite')`. A hash-mismatched download is
discarded and never installed.

The download is cached by hash in `.tmp/runtime-download/`, so a second build is
offline and reproducible once `runtime/node.exe` is in place. CI gets the exact
same bytes by running the same command.

## Where it ends up

electron-builder copies `node.exe` and `LICENSE` to `resources/runtime/` next to
the app (via `extraResources`), **outside** the asar — a binary inside an archive
cannot be executed. `runtime/**` is excluded from `build.files` so the installer
never carries a second copy.

## How it is chosen

`runtime-resolver.cjs` probes a candidate before trusting it (version >= 22.5 and
`node:sqlite` loads):

1. `ISK_NODE_PATH` — explicit override, for support only.
2. `resources/runtime/node.exe` — the shipped runtime.

A packaged build stops there. It deliberately does **not** fall back to Electron's
Node or to a system/`PATH` installation: that is what made the app work on a
developer machine and fail on a clean one. If the bundled runtime is missing or
fails the probe, startup shows an "installation is incomplete, reinstall" dialog
and no backend is started.

In development the checkout has no bundled runtime, so the search is wider:
`ISK_NODE_PATH`, `runtime/node.exe`, Electron's own Node, then system Node.

## Updating the runtime

1. Pick a Node release >= 22.5 that is still in support.
2. Read its `node.exe` SHA-256 from the official `SHASUMS256.txt`.
3. Update `runtime.json` (`nodeVersion`, `source`, `checksums`, `sha256`,
   `license`, `licenseSha256`) together.
4. Delete `runtime/node.exe` and `runtime/LICENSE`, then `npm run runtime:fetch`.
5. `npm test` (the manifest tests enforce that the pin is x.y.z, that the source
   matches the version, and that the version satisfies the backend floor).

Node.js is MIT licensed; the bundled `LICENSE` must stay next to `node.exe` in
the installer.
