# Code signing runbook — IS King Panel

Operational procedure for obtaining, using, rotating and recovering a Windows Authenticode
certificate. [PHASE_1_3_4_SIGNING_READINESS.md](PHASE_1_3_4_SIGNING_READINESS.md) records the
audit and the Phase 1.3.5 remediation.

**Current state: no certificate exists. Local builds are unsigned and say so. A tag build
refuses to run without a signer and a pinned publisher.**

## 1. Certificate procurement checklist

Buy **OV, not EV**, unless a channel demands EV (kernel drivers, some enterprise procurement
lists). Since March 2024 EV no longer bypasses SmartScreen, so the premium buys nothing here.

Because the CA/Browser Forum baseline requirements (effective 1 June 2023) require every
publicly trusted code-signing private key to live in a FIPS 140-2 Level 2 / CC EAL4+ hardware
module, no vendor will hand you a downloadable PFX. Supported signers:

| Provider | How it signs | Works on hosted CI |
| --- | --- | --- |
| **`esigner` — SSL.com eSigner** (recommended) | SSL.com's CodeSignTool calls their HSM | yes |
| `pfx` — PKCS#12 file | electron-builder + signtool | only where a key is exportable (self-hosted, internal builds) |

Not supported: Azure Artifact Signing, which is unavailable to an India-registered publisher;
and a USB token on a GitHub-hosted runner, which has no token attached.

Before paying, confirm in writing:

1. The legal entity name that becomes the certificate **CN**. It is the publisher identity users
   see, and it must be copied into `iskSigning.expectedPublisher` — the build fails closed until
   it is.
2. That the vendor will issue to an **India-registered** entity, from which region.
3. The provisioning method and whether CI signing is metered per signature. A release signs
   four files — `IS King Panel.exe`, `elevate.exe`, the NSIS uninstaller and the installer — so
   SSL.com's 240 signings/yr (Tier 1) is roughly 60 releases. The bundled `node.exe` is excluded
   from signing, so it consumes none.
4. Validity: publicly trusted code-signing certificates are capped below 460 days, so a
   multi-year purchase means re-issuance during the term.
5. Timestamping: free and independent of the vendor, via `http://timestamp.digicert.com`.

## 2. Publisher pinning (do this first)

`package.json` → `iskSigning.expectedPublisher` is the single authoritative identity. It is used
in four places, all of which fail closed when it is empty or wrong:

- `electron-builder.config.cjs` writes it into `win.signtoolOptions.publisherName`, which
  electron-builder copies into `resources/app-update.yml`;
- `scripts/release-verify.mjs` refuses a signature from any other publisher, even a trusted one;
- `scripts/build-release.mjs` refuses an `app-update.yml` whose `publisherName` disagrees;
- `updater-policy.cjs`, at runtime, refuses to check for updates unless the packaged feed
  declares exactly that publisher.

Why the runtime check exists: `electron-updater`'s NSIS updater returns early — *skipping*
verification — when `app-update.yml` has no `publisherName`
(`electron-updater/out/NsisUpdater.js`, `verifySignature`). It also accepts a matching CN
without checking the rest of the distinguished name. The application therefore makes the trust
decision itself before asking for updates.

```json
"iskSigning": {
  "provider": "esigner",
  "expectedPublisher": "Your Legal Entity Name Ltd",
  "timestampServer": "http://timestamp.digicert.com",
  "hashAlgorithm": "sha256",
  "uninstallerName": "Uninstall IS King Panel.exe"
}
```

## 3. Secure credential storage

What must never exist: a PFX, a token PIN or an eSigner password in the repository, in an
installer, in a CI log, or in a chat message. `.gitignore` ignores `*.pfx`, `*.p12`, `*.pvk`,
`*.p7b`, and `npm run check:data` fails if those rules are removed or such a file is tracked.

The signing code prints only *which credential names are missing*, and `scripts/cloud-sign.mjs`
redacts every configured credential value from the signer's output before logging it. The
credentials are passed to the provider CLI as arguments (its only interface) with `windowsHide`,
never through a shell string.

**Local development.** Export the variables for one command, or keep them in an untracked file
outside the repository. Packaging runs electron-builder with `CSC_IDENTITY_AUTO_DISCOVERY=false`,
so it never silently uses an unrelated certificate from the Windows store.

## 4. GitHub Actions setup

Repository → Settings → Secrets and variables → Actions.

Secrets (only the set for your provider needs values):

| Provider | Secrets |
| --- | --- |
| `esigner` | `ESIGNER_USERNAME`, `ESIGNER_PASSWORD`, `ESIGNER_TOTP_SECRET`, `ESIGNER_CREDENTIAL_ID` |
| `pfx` | `CSC_LINK` (base64 PFX), `CSC_KEY_PASSWORD` |

Variables: `ISK_SIGN_PROVIDER=esigner` and `ESIGNER_CLI` (path to `CodeSignTool.bat`, default
found on `PATH`; the Windows download bundles its own JRE, so no JDK step is needed).
`ESIGNER_SANDBOX=1` selects SSL.com's sandbox by exporting `ENVIRONMENT_NAME=TEST` to the
signer — the tool switches endpoints by variable, not by a second executable.

The workflow:

1. `scripts/check-signing-env.mjs` — provider selected, credentials complete, CLI resolvable,
   publisher pinned. Seconds, before anything is built.
2. `npm run electron:build` with `ISK_REQUIRE_SIGNING=1`; packaging uses
   `electron-builder.config.cjs`, which forces SHA-256 and installs the cloud sign hook.
3. `release-assets.mjs --runtime --privacy --signing` and `verify-signatures.mjs --require` —
   trust chain, timestamp, digest and pinned publisher on the exact bytes to be uploaded.
4. Publish job re-verifies the downloaded bytes, then re-reads the published release.

Only the build job receives signing credentials. The publish job runs with `contents: write` and
no signer secrets.

## 5. Signing locally

**Cloud (same signer as CI):**

```powershell
$env:ISK_SIGN_PROVIDER = 'esigner'
$env:ESIGNER_USERNAME  = 'publisher@example.com'
$env:ESIGNER_PASSWORD  = '<from your secret store>'
$env:ESIGNER_TOTP_SECRET = '<from your secret store>'
$env:ESIGNER_CREDENTIAL_ID = '<from the SSL.com portal>'
$env:ESIGNER_CLI = 'C:\CodeSignTool\CodeSignTool.bat'
$env:ISK_REQUIRE_SIGNING = '1'
npm run electron:build
```

electron-builder calls `scripts/cloud-sign-hook.cjs` for the app, `elevate.exe`, the
uninstaller and the installer; each is signed by SSL.com's HSM and then verified locally before
the next step. To sign one file by hand: `node scripts/cloud-sign.mjs --file "<path to exe>"`.

Three CodeSignTool limits are worth knowing: it always timestamps (the authority is `TSA_URL` in
its own `conf/code_sign_tool.properties`, `http://ts.ssl.com` by default, with
`http://ts.ssl.com/legacy` for RSA units), it has no digest or timestamp flag, and it must be
given an output directory — otherwise it overwrites the input and prompts, which hangs CI. The
adapter therefore signs into a temporary directory, copies the result back and then verifies
publisher, timestamp and SHA-256 itself.

**PFX (self-hosted only):**

```powershell
$env:ISK_SIGN_PROVIDER = 'pfx'
$env:CSC_LINK = 'C:\secrets\iskingpanel.pfx'
$env:CSC_KEY_PASSWORD = '<from your secret store>'
$env:ISK_REQUIRE_SIGNING = '1'
npm run electron:build
```

Signing order: `IS King Panel.exe`, then the NSIS uninstaller, then the installer, each
timestamped over RFC 3161. `scripts/after-pack.cjs` verifies `resources/runtime/node.exe` before
NSIS compresses 130 MB and aborts a release build if that upstream signature is broken; the
runtime is never re-signed. Remove the variables when finished.

## 6. Verifying a signed build

```powershell
npm run verify:signing                      # policy: trusted, timestamped, SHA-256, pinned publisher
npm run verify:signing -- --installed "C:\Program Files\IS King Panel"   # + the uninstaller
signtool verify /pa /all /v "dist_electron\IS-King-Panel-Setup-1.0.2.exe"
Get-AuthenticodeSignature "dist_electron\IS-King-Panel-Setup-1.0.2.exe" |
  Format-List Status, SignerCertificate, TimeStamperCertificate
```

Expected: `Status = Valid`, one signer whose CN equals `iskSigning.expectedPublisher`, a
`TimeStamperCertificate`, one `SHA256` digest (`readDigests` decodes the PKCS#7 to check this — a
dual-signed SHA-1/SHA-256 file fails), and `signtool` agreeing. Check all three artifacts:
installer, `win-unpacked\IS King Panel.exe`, and `resources\runtime\node.exe` (which must still
read `OpenJS Foundation`).

**The uninstaller only exists after installation.** electron-builder generates and signs it
inside the installer, so there is no file to check in `dist_electron`; `--installed` reads it
from the installed directory and applies the same publisher, timestamp and digest rules. Until
an install has been performed, `verify:signing` reports it as
`uninstaller: not present yet — generated inside the installer` and does not claim it was
checked.

Timestamp verification specifically:

```powershell
(Get-AuthenticodeSignature .\dist_electron\IS-King-Panel-Setup-1.0.2.exe).TimeStamperCertificate |
  Format-List Subject, NotAfter
```

A signature without a timestamp fails the policy: it stops verifying when the certificate
expires. On the eSigner path the authority is SSL.com's `http://ts.ssl.com`; the
electron-builder `rfc3161TimeStampServer` setting applies only to the PFX path, because the
cloud hook replaces signtool entirely.

## 7. Renewal and rotation

- Start 60 days before expiry; re-issuance under the sub-460-day cap is routine.
- Keep the same CN — a changed publisher is a publisher change, and resets SmartScreen reputation.
- Re-issue, sign a test build, run the §6 checks, then rotate the CI secret.
- Timestamped old installers keep verifying; do not revoke the old certificate unless compromised.
- The gate already refuses a build whose files use two different certificates.

## 8. Lost, stolen or compromised key

1. Revoke at the CA immediately (this is also why eSigner's HSM custody matters).
2. Rotate the CI secret and every local copy; treat builds signed after the compromise as suspect.
3. Remove affected releases, publish a security notice, re-issue under a new key.
4. Do not re-timestamp pre-compromise artifacts.

## 9. Recovery and rollback

- Signing failure mid-release: the tag workflow stops before uploading. Fix the credential or
  the CA outage and re-run the workflow for the same tag; nothing is published until both
  verification steps pass.
- Bad installer published: releases are immutable in this workflow. Bump the version, tag a new
  commit, publish that, and mark the bad release. Installed copies update forward only.
- Provider unreachable: do not ship unsigned and do not remove `ISK_REQUIRE_SIGNING`. Retry, or
  switch provider deliberately and record the change.
- Keep `dist_electron/*.log` and the workflow's `release-build-log` artifact for post-mortems.

## 10. Signer troubleshooting (from the 2026-11-03 sandbox run)

- **`FileNotFoundException: .\conf\code_sign_tool.properties`** — CodeSignTool resolves `./conf`
  and its bundled JRE relative to the *working directory*, not to its own location. Run it from
  its folder; `scripts/cloud-sign.mjs` does this automatically.
- **`unable to find valid certification path` from the bundled JDK 11** — the JRE shipped in the
  Windows package has an old trust store, which failed TLS against `oauth-sandbox.ssl.com` here.
  The system JDK (25) worked. On a runner, either update the bundled `cacerts` or point
  `ESIGNER_CLI` at a wrapper that uses an installed JDK.
- **`UnknownError` / `0x800B010A` with a sandbox signature** — expected: the sandbox certificate
  chains to `SSL.com EV Root Certification Authority RSA R2 - Development`, which is in no trust
  store. Production chains to the public SSL.com root. Our gate refuses the sandbox file, and
  that is the correct behaviour, not a defect.
- **`invalid otp`** — the runner clock is skewed; the TOTP window is short.
- **`ASN1 value too large`** — you are feeding a whole executable to a PKCS#7 decoder. Use
  `signtool verify /pa /all /v` and read its `Hash of file (sha256)` lines, as the project's
  digest check does.
