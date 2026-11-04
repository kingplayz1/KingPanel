# Phase 1.3.4 — Code signing readiness audit

**Verdict at audit time: IMPLEMENTATION DEFECTS FOUND.** Four defects (D1–D4) affected a
*signed* build and were closed in Phase 1.3.5 (§9); a fifth (D5) was a repository hygiene hole
and was fixed during the audit. The purchase decision is unchanged: **an OV certificate
delivered through a cloud signing service is the right purchase**. No release was published, no
certificate was bought or generated, and `ISK_REQUIRE_SIGNING` was not weakened.

> **Status after Phase 1.3.5:** D1–D4 are implemented and covered by mocked tests; real signing
> remains **NOT TESTED**, because no certificate exists. See §9 for what changed and what is
> still unproven.

Audit date: 2026-11-03. No production signing has been performed, because there is no
legitimate certificate; every statement about a signed build below is derived from the code,
from electron-builder's own implementation in `node_modules/app-builder-lib`, and from
vendor documentation.

## 1. What is signed, in what order

| Artefact | Signed by | Notes |
| --- | --- | --- |
| `IS King Panel.exe` (`win-unpacked`) | our certificate | signed by electron-builder during packaging |
| `IS-King-Panel-Setup-<version>.exe` (installer) | our certificate | signed after the app, before `latest.yml`/blockmap are written |
| `Uninstall IS King Panel.exe` (NSIS uninstaller) | our certificate | generated and signed inside the installer |
| `resources/runtime/node.exe` | **OpenJS Foundation**, upstream | never re-signed; verified against the `publisher` pin in `runtime/runtime.json` |

Signing order observed in `scripts/build-release.mjs`: backend → UI → runtime fetch →
electron-builder (app, then uninstaller, then installer) → packaged-runtime and privacy
checks → release consistency (`latest.yml`, blockmap, sha512) → `verify-signatures.mjs`.
The afterPack hook (`scripts/after-pack.cjs`) verifies the upstream runtime signature before
NSIS spends a minute compressing 130 MB, so a broken runtime aborts early.

Timestamping: electron-builder signs with `/tr <rfc3161> /td sha256` and defaults the server to
`http://timestamp.digicert.com` (confirmed in
`node_modules/app-builder-lib/out/codeSign/windowsSignToolManager.js` and
`out/options/winOptions.d.ts`). No `win.signtoolOptions` is configured, so the default applies.

Digest: `win.signtoolOptions.signingHashAlgorithms` is unset, and electron-builder's default is
`['sha1', 'sha256']` — see **D3**.

## 2. What the verification chain actually proves

`npm run verify:signing` (local) and `verify-signatures.mjs --require` (release) call
`verifyReleaseSignatures`, which checks the installer and the app executable with
`Get-AuthenticodeSignature`, then adds `signtool verify /pa /all /v` as a second opinion in
release mode. The policy in `scripts/signing.mjs` requires, per file: `Status = Valid`,
a timestamp, and a publisher matching an expected value where one is supplied. Across our
files it also requires **one** certificate (thumbprint set size ≤ 1), so a build cannot mix
two publishers. The runtime must be `Valid`, timestamped, and signed by `OpenJS Foundation`.

Failure modes covered: unsigned, tampered/corrupted (`HashMismatch`), untrusted chain,
untimestamped, different certificate, missing file, and (release mode) signtool disagreeing
with PowerShell. Missing or invalid credentials fail before anything is built: the workflow
checks `CSC_LINK`/`CSC_KEY_PASSWORD` presence, and `signingConfig()` reports a PFX without a
password as a problem.

Observed on the current unsigned build (2026-11-03):

```
[signing] IS-King-Panel-Setup-1.0.2.exe: NotSigned
[signing] IS King Panel.exe: NotSigned
[signing] resources/runtime/node.exe: OpenJS Foundation, timestamped
[signing] no certificate configured … this build is UNSIGNED. That is fine locally and is refused in release mode.
[signing] OK  local build: checked, strictness off
```

What it does **not** prove: that a real certificate is trusted, that the installer was signed
by *our intended* publisher, or that the uninstaller signature is valid. See D1–D4.

## 3. Updater verification

`electron-main.cjs` uses `electron-updater` with `autoDownload = true` and
`checkForUpdatesAndNotify()`; there is no custom publisher check in application code. The
download is verified two ways: `latest.yml` carries the installer's SHA-512 and size (checked
against the served bytes by the harness: `downloaded bytes match the served installer`), and
the NSIS installer signature is verified by electron-updater against `publisherName` from
`app-update.yml` (`win.verifyUpdateCodeSignature` defaults to `true`).

The unsigned build's `app-update.yml` contains only `owner`, `repo`, `provider`,
`updaterCacheDirName` — no `publisherName` — so today an installed copy checks the hash but
**not** a publisher. With signing configured, electron-builder derives `publisherName` from
the certificate CN, which means the check is self-consistent with whatever certificate
signed the build. That is **D2**.

## 4. Certificate options

Costs below are USD list prices as published on the vendor page, checked 2026-11-03 where the
page was readable; anything marked *estimate* came from a reseller and must be confirmed by
quote. Publicly trusted code-signing certificates are now capped at under 460 days of validity,
so multi-year purchases mean re-issuance, not one key for years.

| Option | Price (observed) | Key custody | CI on hosted runners | India purchase |
| --- | --- | --- | --- | --- |
| **SSL.com OV + eSigner Tier 1** | $129/yr OV + $180/yr eSigner (240 signings) ≈ **$309/yr** (official pages) | cloud HSM, eSigner API | yes, REST/CodeSignTool CLI | yes (vendor sells globally; confirm at order) |
| DigiCert OV + KeyLocker | ~$400–500/yr OV (*reseller estimate*) + KeyLocker included, **1,000 signatures per certificate** | DigiCert cloud HSM | yes, SMCTL/CI action (migrating to "DigiCert Binary Signing" in 2026) | yes |
| Sectigo OV | from ~$536/yr on a 5-year plan (vendor page meta) | token or HSM/attestation | only via cloud HSM or token on self-hosted runner | yes |
| GlobalSign OV | "from $529/yr" (snippet; *unverified*) | token; HSM option | HSM + `signtool` CSP | yes, order from the region of registration |
| EV (SSL.com / DigiCert / Sectigo) | $349 / ~$560 / ~$411–453 per year (*two are reseller prices*) | mandatory HSM, token may not qualify | same as OV | yes, no benefit here |
| **Azure Artifact Signing** | $9.99/mo Basic (5,000 signatures) | Microsoft-managed | native `win.azureSignOptions` + OIDC | **no** — Public Trust is limited to US/CA/EU/UK/AU/NZ/JP/KR/SG/CH/NO/IL; individual developers US/CA only |

Why OV rather than EV: Microsoft's SmartScreen guidance (updated 2026) states EV no longer
bypasses SmartScreen; both OV and EV build hash+publisher reputation over weeks. EV still
matters for kernel drivers and some enterprise procurement lists, neither of which applies to
a Minecraft server manager distributed as a download.

**Recommended:** SSL.com OV ($129/yr) with eSigner Tier 1 ($180/yr, 240 signatures/year) —
about $309/yr, the cheapest route that works from GitHub-hosted runners for an India-based
publisher. Recount signature usage before renewing: each signed file counts, and a release
signs the app, the uninstaller and the installer.

Sources (read during this audit): DigiCert private-key storage requirement KB
(`knowledge.digicert.com/general-information/new-private-key-storage-requirement-for-standard-code-signing-certificates-november-2022`),
SSL.com OV/EV and eSigner pricing pages (`ssl.com/products/software-integrity/code-signing/ov/`,
`/ev/`, `ssl.com/guide/esigner-pricing-for-code-signing/`), Microsoft Learn SmartScreen
reputation (`learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation`),
Microsoft Learn Azure Artifact Signing quickstart and FAQ (`learn.microsoft.com/en-us/azure/artifact-signing/quickstart`,
`/faq`), electron-builder Windows code-signing docs and the installed `app-builder-lib`
(`node_modules/app-builder-lib/out/codeSign/windowsSignToolManager.js`), DigiCert and Sectigo
timestamp-authority pages.

Timestamp servers (free, any certificate): DigiCert `http://timestamp.digicert.com` (RFC 3161,
documented), Sectigo `http://timestamp.sectigo.com`, GlobalSign
`http://rfc3161timestamp.globalsign.com/advanced` (third-party sources only — verify before
relying on it). A timestamp taken at signing time keeps the signature verifiable after the
certificate expires, which is why the policy refuses an untimestamped signature.

## 5. Release policy — confirmed

| Requirement | Status | Evidence |
| --- | --- | --- |
| Unsigned release builds remain blocked | **Confirmed** | `ISK_REQUIRE_SIGNING=1` in the tag workflow; `signingConfig` reports a missing `CSC_LINK` as a problem; `verifyReleaseSignatures` adds a problem when release mode has no certificate; `verify-signatures.mjs --require` exits 1 |
| Bundled Node.js keeps its OpenJS signature | **Confirmed** | never re-signed (`extraResources` copy, no sign hook); `after-pack.cjs` verifies publisher `OpenJS Foundation` against `runtime/runtime.json` before compression; observed `[signing] resources/runtime/node.exe: OpenJS Foundation, timestamped` |
| App publisher identity is checked after signing | **Partially — D2** | one-certificate consistency is enforced; no *expected* publisher is pinned, and `app-update.yml` derives `publisherName` from whatever certificate signed |
| Installer, uninstaller and app executables covered | **Partially — D4** | installer + app exe verified by the gate; the uninstaller is signed by electron-builder but never verified by this project |
| Timestamped signatures survive expiry | **Confirmed by design** | timestamp required by policy; electron-builder uses RFC 3161 by default; no timestamp ⇒ release failure |
| No private key or certificate in installer or repo | **Fixed (D5)** | `build.files` excludes `**/*.pfx`, `**/*.p12`; `.gitignore` now ignores `*.pfx`, `*.p12`, `*.pvk`, `*.p7b`; `check:data` asserts those rules and fails if removed |

## 6. Defects

**D1 — the pipeline assumes an exportable PFX.** `signingConfig()` understands only
`CSC_LINK`/`CSC_KEY_PASSWORD`, and `build-release.mjs` reports posture from `CSC_*`/
`WIN_CSC_*` only. Since June 2023 no CA issues a downloadable PFX for a publicly trusted
certificate, so the realistic purchase (eSigner, KeyLocker, Azure) would be reported as
"no certificate configured" and the release gate would fail on a *correctly signed* build.
Fix: teach `signingConfig` about the chosen cloud provider (or a generic custom `sign` hook
marker), and have the gate verify the resulting signature rather than the credential's shape.

**D2 — publisher identity is not pinned.** Any trusted, timestamped certificate passes
release verification as long as it is the same across our files; `app-update.yml` then
contains whatever CN that certificate had. Fix: set `win.publisherName` to the purchased CN
and pass the same expected publisher into `verifyReleaseSignatures` (the parameter already
exists in `checkSignature`), plus assert it in the updater metadata.

**D3 — SHA-1 nested signing left enabled.** `signingHashAlgorithms` defaults to
`['sha1', 'sha256']`, so every artefact carries a deprecated SHA-1 signature in addition to
SHA-256. Fix: set `["sha256"]` in `win.signtoolOptions` when signing is enabled.

**D4 — the uninstaller's signature is never verified.** electron-builder signs it, but
`releaseExecutables()` lists only the installer and the app exe. Fix: after a real
`verify:install-machine` run, check the installed `Uninstall IS King Panel.exe` (that phase is
currently blocked, so this is untestable today).

**D5 — signing material could be committed (fixed).** `.gitignore` had no rules for PFX/PVK
files. Added `*.pfx`, `*.p12`, `*.pvk`, `*.p7b`, and `check:data` now fails if those rules
disappear or such a file is tracked.

## 7. Tests

Run on 2026-11-03 against the final tree:

| Command | Result |
| --- | --- |
| `npm test` | PASS — 313 tests, 0 failures (includes the mocked Authenticode policy suite) |
| `npm run verify:signing` | PASS — installer and app exe unsigned, runtime `OpenJS Foundation, timestamped` |
| `npm run check:release` | PASS — artifacts, packaged runtime, privacy, signing policy |
| `npm run lint` | PASS |
| `npm run check:docs` | PASS |
| `npm run check:data` | PASS — includes the new signing-key ignore assertions |

`signtool` is installed on this machine (Windows Kits `10.0.26100.0`), so the release-mode
second opinion is available locally as well as on `windows-latest`. It is simply unexercised:
the current build is unsigned and no signed artefact exists, so no test in this phase proves a
real certificate chain.

## 8. Verdict and next actions

**IMPLEMENTATION DEFECTS FOUND** — D1–D4 are code gaps around a signed build, D5 is fixed.
The purchase decision itself is ready: OV certificate via a cloud signing service, budget
≈$300–500/yr, and an India-registered entity is served by SSL.com and DigiCert but **not** by
Azure Artifact Signing.

Order of work: (1) buy OV + eSigner (or KeyLocker) and record the certificate CN; (2) close
D1, D2 and D3 in one change with the CN pinned, and extend the mocked tests; (3) sign one
build and verify it with `signtool verify /pa /all` plus `Get-AuthenticodeSignature` using the
procedures in [CODE_SIGNING_RUNBOOK.md](CODE_SIGNING_RUNBOOK.md); (4) close D4 once Phase 1.3.3
can run on a VM, where an installed uninstaller exists.

No release was published from this phase.

## 9. Phase 1.3.5 remediation record

Implemented before certificate purchase, so the first paid signing run is not also the first
test of the pipeline.

| Defect | Resolution | Where |
| --- | --- | --- |
| **D1** PFX-only pipeline | Provider-neutral `resolveProvider`/`signingConfig` (`pfx`, `esigner`); SSL.com eSigner adapter that signs through the provider CLI with credentials from the environment only, redacting them from output; a `check-signing-env.mjs` preflight for CI and local use; explicit refusal of an unknown provider, of two credential sets at once, and of a partial eSigner configuration | `scripts/signing.mjs`, `scripts/cloud-sign.mjs`, `scripts/cloud-sign-hook.cjs`, `scripts/check-signing-env.mjs` |
| **D2** No pinned publisher | `iskSigning.expectedPublisher` is the single identity, enforced in four places: electron-builder writes it to `app-update.yml`; build verification rejects any other publisher; `build-release` rejects an `app-update.yml` that disagrees; and `updater-policy.cjs` refuses to check for updates when the installed feed lacks or contradicts it (electron-updater *skips* verification in that case) | `package.json`, `electron-builder.config.cjs`, `scripts/release-verify.mjs`, `scripts/build-release.mjs`, `updater-policy.cjs` |
| **D3** SHA-1 dual signing | `win.signtoolOptions.signingHashAlgorithms: ["sha256"]` plus RFC 3161 server; release verification decodes the PKCS#7 and rejects a SHA-1 signature or any digest other than SHA-256; the cloud hook refuses to produce a non-SHA-256 signature | `electron-builder.config.cjs`, `scripts/signing.mjs` (`readDigests`, `digestPolicy`), `scripts/cloud-sign-hook.cjs` |
| **D4** Uninstaller unverified | `releaseExecutables` discovers the uninstaller (installed directory, then `win-unpacked`) and adds it to the same publisher/timestamp/digest policy; `--installed <dir>` makes it mandatory and reports a missing one instead of skipping it | `scripts/release-verify.mjs`, `scripts/verify-signatures.mjs`, `scripts/release-assets.mjs` |
| **D5** Signing material committable | Fixed during the audit (`.gitignore` rules plus `check:data` assertions) | `.gitignore`, `scripts/check-tracked-data.mjs` |
| **D6** Bundled runtime re-signed | Found in the Phase 1.3.6 build log: electron-builder signs every `.exe` in the app directory (`winPackager.js` `shouldSignFile` falls back to `isExe`), so `resources/runtime/node.exe` would have lost its OpenJS signature and consumed a paid signing operation. Excluded with `win.signExts: ["!node.exe"]`, and the cloud hook refuses that path outright | `package.json`, `scripts/cloud-sign-hook.cjs` |

Electron-builder configuration moved into `electron-builder.config.cjs`, derived from
`package.json` at load time: JSON cannot express a conditional sign hook, and a custom hook
replaces electron-builder's own signtool invocation, so it must only be installed for the cloud
provider. NSIS options, files, resources and publish settings still have exactly one definition
(in `package.json`), and `build-release.mjs` passes the derived config with `--config`.

### Still not proven

- **No real signature exists.** Every new test injects mocked `Get-AuthenticodeSignature`,
  digest and provider output. Mocked coverage is labelled as such and is not evidence that a
  certificate chain validates.
- **The updater has not been exercised against a signed installer.** `updater-policy.cjs` is
  unit-tested, but the end-to-end case — a correctly signed update accepted, and a deliberately
  mismatched publisher rejected with `ERR_UPDATER_INVALID_SIGNATURE` — needs a signed build.
- **The eSigner adapter ran only against the vendor sandbox** (2026-11-03). It signed a real
  copy of the app through CodeSignTool 1.3.2 and produced a **SHA-256** signature with a valid
  timestamp chain; that file was then refused by this project's gate because the sandbox
  certificate chains to a *development* root. So the pipeline is proven, production issuance is
  not. Evidence and limits:
  [PHASE_1_3_6_CERTIFICATE_PROCUREMENT.md](PHASE_1_3_6_CERTIFICATE_PROCUREMENT.md) §9.
- **No installed build was checked**, so the uninstaller path in `--installed` is unexercised
  (Phase 1.3.3 is still blocked on a VM).
- **`signtool verify /pa /all` remains unexercised** because it only runs for signed artifacts.

### Validation run

| Command | Result |
| --- | --- |
| `npm test` | PASS — 351 tests, 0 failures (38 new: providers, digests, pinning, uninstaller, updater policy, cloud adapter, `.bat` launcher) |
| `npm run verify:signing` | PASS — local unsigned build; runtime verified; uninstaller reported absent |
| `npm run check:release` | PASS |
| `npm run lint` | PASS |
| `npm run check:docs` | PASS |
| `npm run check:data` | PASS |
| `npm run build` | PASS |
| `npm run build:backend` | PASS |
| `npm run electron:build` | PASS — installer rebuilt with the derived config |
| `signtool verify /pa /all /v` | **NOT TESTED on production artifacts** — run against the sandbox-signed copy instead: SHA-256 signature, timestamped, timestamp chain verified; refused only because the sandbox chains to a development root (evidence: PHASE_1_3_6 §9) |
