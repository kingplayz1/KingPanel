# Phase 1.3.3 — Real per-machine installation validation

**Status: BLOCKED — environment unavailable (recorded 2026-11-04). Nothing in this phase has
been executed, and no row is `PASS`.**

Two disposable Windows environments (Windows 10 22H2 and Windows 11), each with an elevated
shell and a separate non-administrator test account, have not been provided. This is a
**blocked** status, not a pass and not a partial pass.

Every platform row below is `NOT TESTED`. No row may be marked `PASS` from this document,
from `npm test`, or from the per-user upgrade gate — those exercise different code paths.
Per-machine release readiness is therefore **not claimed**.

## Why it is blocked

| Requirement | Available on the development host (re-checked 2026-11-04) |
| --- | --- |
| Windows 10 22H2 VM with a fresh snapshot | none — no Hyper-V module, no VirtualBox, no VMware, no QEMU |
| Windows 11 VM with a fresh snapshot | none — same |
| Elevated shell for a per-machine install | no (`IsInRole(Administrator)` is `False`) |
| Machine that is *not* the developer's daily system | no — the only Windows host present is the development machine |

The development machine must not be used for this phase (safety rule 7.2), and the
harness deliberately refuses to elevate itself, so the run cannot be produced from here.

## Hand-off requirements

What the two environments must be, so a run is not attempted on a host that cannot produce
usable evidence.

| Item | Requirement |
| --- | --- |
| Operating systems | Windows 10 22H2 (build 19045) and Windows 11, as two separate clean installations |
| Snapshot | taken on each VM *before* the installer is copied in, so a dirty run can be reverted |
| Accounts | one administrator (the elevated shell) and one separate **standard** user for the two-account test |
| Disk | at least 10 GB free beyond the OS: installer (~131 MB), installed app, a test world and backups |
| Network | internet access — the app's first run and server creation need it |
| Absent before the run | `C:\Program Files\IS King Panel`, the `HKLM\...\Uninstall\com.kingplayz.iskingpanel` key, and any system Node (`where node` must fail) |
| Never this machine | not the developer's daily installation; the harness refuses to elevate itself and safety rule 7.2 forbids it |

Each `--run` writes `evidence/evidence-<platform>-<host>-<timestamp>.txt` itself: OS build,
installer size and SHA-256, elevation, and every `PASS`/`FAIL` line. The file is git-ignored
because it names real machines and accounts. `--run` refuses to start without
`--platform win10|win11`, because one run must never be filed as evidence for both.

## Artefact under test

| Field | Value |
| --- | --- |
| Installer | `dist_electron/IS-King-Panel-Setup-1.0.2.exe` |
| Size | 131,347,121 bytes |
| SHA-256 | `b1311ce9a439a0239b6364c1a78069da7376440f1eeff82515ae3156c7d70510` |
| Built | 2026-11-03 (per-machine NSIS, `nsis.perMachine: true`) |
| Signing | unsigned — expected for this phase; SmartScreen will warn |

Installers are not bit-reproducible, so re-check this hash on the VM before every run and
record it in the report. Do not test a rebuilt installer without updating the hash: this row
was already stale once, after the `win.signExts` rebuild changed both size and digest.

## Environment to record before each run

Windows edition and build (`winver`, `[Environment]::OSVersion.Version`), architecture,
VM snapshot name, test account names, installer SHA-256, and the date. Do not record
passwords, tokens, recovery codes or API keys anywhere in the evidence.

## Test matrix

Both platforms run the same sequence. Replace `<platform>` with `win10` or `win11`.

### Windows 10 22H2

| Test | Result | Evidence |
| --- | --- | --- |
| UAC administrator prompt | NOT TESTED | visible installer run, screenshot of the prompt |
| Cancelled UAC installs nothing | NOT TESTED | after cancelling: `dir` fails, HKLM key absent |
| Install into Program Files | NOT TESTED | `dir "%ProgramFiles%\IS King Panel"` |
| Launch application | NOT TESTED | process + window, harness step log |
| Bundled Node.js backend | NOT TESTED | harness "bundled runtime in use" line |
| Separate Windows-user data | NOT TESTED | `%APPDATA%\IS King Panel` per account |
| Create and manage server | NOT TESTED | server id, port, console output |
| Upgrade installation | NOT TESTED | `--update-installer` log, version after update |
| Preserve account and world data | NOT TESTED | login after update, world files intact |
| Uninstall and reinstall | NOT TESTED | registry query, `%APPDATA%` still present |

### Windows 11

| Test | Result | Evidence |
| --- | --- | --- |
| UAC administrator prompt | NOT TESTED | visible installer run, screenshot of the prompt |
| Cancelled UAC installs nothing | NOT TESTED | after cancelling: `dir` fails, HKLM key absent |
| Install into Program Files | NOT TESTED | `dir "%ProgramFiles%\IS King Panel"` |
| Launch application | NOT TESTED | process + window, harness step log |
| Bundled Node.js backend | NOT TESTED | harness "bundled runtime in use" line |
| Separate Windows-user data | NOT TESTED | `%APPDATA%\IS King Panel` per account |
| Create and manage server | NOT TESTED | server id, port, console output |
| Upgrade installation | NOT TESTED | `--update-installer` log, version after update |
| Preserve account and world data | NOT TESTED | login after update, world files intact |
| Uninstall and reinstall | NOT TESTED | registry query, `%APPDATA%` still present |

Legend: `PASS` executed by a human on that VM and observed · `FAIL` executed and failed ·
`NOT TESTED` not executed · `MOCKED` simulated in `test/install-modes.test.mjs` only.

### What is already covered, and what that does not prove

| Coverage | Mode | Proves |
| --- | --- | --- |
| `npm run verify:upgrade` (PASS, 2026-11-03) | per-user fixtures | update/download/uninstall logic and data preservation for a per-user install |
| `test/install-modes.test.mjs` (39 tests) | MOCKED | elevation classification, install sequence, rollback, cache rules |
| `npm run verify:install-machine` preflight | read-only | the plan, paths, HKLM key and elevation state are detected correctly |
| install into `%ProgramFiles%`, HKLM registration, all-users shortcuts, UAC | — | **nothing yet** |

A per-user result is not evidence for a per-machine result: different install root,
different registry hive, different shortcut scope, and an elevation step that per-user
installers never perform.

## Procedure per platform

1. Restore the clean snapshot. Confirm no `C:\Program Files\IS King Panel`, no
   `IS King Panel` entry under `HKLM\...\Uninstall`, and no system Node.js
   (`where node` fails).
2. Copy the installer, verify the SHA-256, record Windows build and the date.
3. **UAC prompt and cancellation.** Run the installer normally (no `/S`), cancel at the
   UAC prompt, then confirm nothing was created:
   `dir "C:\Program Files\IS King Panel"` fails and the HKLM key is absent.
4. **Full per-machine run**, from an elevated PowerShell in the repository:
   ```powershell
   npm run verify:install-machine -- --run --confirm=per-machine-install `
     --platform <win10|win11> --expect-sha256 <hash from the table above> `
     --installer <path>\IS-King-Panel-Setup-1.0.2.exe 2>&1 |
     Tee-Object -FilePath evidence-<platform>-console.txt
   ```
   A mismatched `--expect-sha256` refuses before anything is installed. The harness also
   writes its own `evidence/evidence-<platform>-…txt`; keep both, and quote the hash from the
   harness file in the report rather than retyping it.
   This installs, launches, checks the bundled runtime and the per-user data location,
   uninstalls, verifies the data survived, and reinstalls. Record every `PASS`/`FAIL`
   line; exit 1 means a check failed, exit 2 means the environment was blocked.
5. **Shortcuts and registration**, after the run:
   ```powershell
   dir "$env:PUBLIC\Desktop\*King Panel*"
   dir "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\*King Panel*"
   Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.kingplayz.iskingpanel'
   ```
   The install directory must contain no `userData`, `.env` or database file.
6. **Two Windows accounts.** As account A: register, log in, create one supported server,
   note its id and port, start it, watch the console, stop and restart it, then restart
   the app and confirm the server is still listed. As account B: confirm no session is
   inherited, no server from A is listed, and a direct request for A's server id is
   refused. Record only account names and server ids.
7. **Upgrade**, from the elevated shell, with a second build served from a controlled
   local feed:
   ```powershell
   npm run verify:install-machine -- --run --confirm=per-machine-install `
     --platform <win10|win11> --expect-sha256 <hash of the update build> `
     --update-installer <path>\IS-King-Panel-Setup-<next>.exe 2>&1 |
     Tee-Object -FilePath evidence-<platform>-update.txt
   ```
   Confirm the version changes, account and world data survive, the app launches, and a
   deliberately failed update leaves the previous build installed and usable.
8. **Uninstall and reinstall.** Uninstall from Settings; the install directory must be
   gone, the HKLM key removed and the shortcuts removed, while `%APPDATA%\IS King Panel`
   remains. Reinstall and confirm the account and server come back.
9. Snapshot the evidence files and revert the VM.

## Report

Fill one section per platform with the metadata table plus the matrix above, then state
the verdict. Readiness may be claimed only when **both** platforms show `PASS` on every
row; a single `FAIL` or `NOT TESTED` keeps the release gate closed.

```
Platform:            Windows 10 22H2 (build 19045) | Windows 11 (build ...)
Architecture:        x64
Installer SHA-256:   ...
UAC prompt:          PASS | FAIL | NOT TESTED
Cancelled UAC:       PASS | FAIL | NOT TESTED
Install path:        C:\Program Files\IS King Panel
Backend runtime:     bundled Node.js 22.23.1
User data:           %APPDATA%\IS King Panel (per user)
Server lifecycle:    PASS | FAIL | NOT TESTED
Upgrade:             PASS | FAIL | NOT TESTED
Data preserved:      PASS | FAIL | NOT TESTED
Uninstall/reinstall: PASS | FAIL | NOT TESTED
Verdict:             READY | BLOCKED
```

Recorded results belong in this file, under the matching platform section, with the
  evidence file names. Do not paste credentials into it.

## Execution attempt (2026-11-04)

What was executed before the verdict was recorded, and what stopped it. Every value below was
read from this machine on that date; none of it is a simulated result.

| Probe | How | Result |
| --- | --- | --- |
| Host identity | `Win32_ComputerSystem` | Windows 10 Pro 22H2, 10.0.19045, x64, physical Gigabyte B550 desktop, `DESKTOP-VPEOHS2`, account `KING` |
| Disposable environment? | — | **no** — this is the developer's daily installation, which safety rule 7.2 forbids |
| Hypervisor present | `Win32_ComputerSystem.HypervisorPresent` | `False` |
| VM software | install directories and `PATH` | VirtualBox, VMware, QEMU, Docker, Multipass and Windows Sandbox all absent; `Get-VM` is not a recognised cmdlet |
| Elevation | `IsInRole(Administrator)` | `False` |
| Preflight | `npm run verify:install-machine` | exit **2**, `BLOCKED: this process is not elevated …` |
| Installer size | `stat` | 131,347,121 bytes |
| Installer SHA-256 | `certutil -hashfile … SHA256` plus an independent Node stream | `b1311ce9a439a0239b6364c1a78069da7376440f1eeff82515ae3156c7d70510` from both — matches *Artefact under test* |
| Authenticode | `Get-AuthenticodeSignature` | `NotSigned`, as expected for this build |
| Leftover state | `dir "C:\Program Files\IS King Panel"` and the HKLM query | directory exists and is empty; uninstall key absent |

No install was attempted, and none could have been attempted here: the host is the daily machine
and the harness refuses to elevate itself. Both platforms remain `NOT TESTED`, which is neither a
pass nor a partial pass.

The empty leftover directory was left in place — removing it needs an elevated shell, and that is
the environment owner's decision rather than a cleanup the harness performs. It is worth watching
during the real run: an empty install directory surviving a previous uninstall is consistent with
NSIS leaving the folder behind, but that is unverified and must be checked on the VM rather than
assumed.

### Procedure defects found during the attempt

| Defect | Effect | Correction |
| --- | --- | --- |
| Step 7 omitted `--platform` | every `--run` requires a platform, so the documented upgrade command would have been refused with exit 2 | the command now passes `--platform` and the update build's `--expect-sha256` |
| "All nine rows" under Windows 11 | the matrix has had ten rows since *Cancelled UAC* was added | corrected to ten |
| "(34 tests)" in the coverage table | stale after the evidence tests were added | corrected to 39 |

## Recorded results

### Windows 10 22H2

Not executed. No Windows 10 VM or elevated test host was available; see *Why it is
blocked*. All ten rows above are `NOT TESTED`.

### Windows 11

Not executed. No Windows 11 VM was available; see *Why it is blocked*. All ten rows
above are `NOT TESTED`.

**Release gate: CLOSED.** Per-machine release readiness is not claimed, and no
production release was published from this phase.
