# Phase 1.3.6 — OV cloud certificate procurement (Stage A)

**Status: awaiting a purchase decision. Nothing has been bought, configured or signed.**
Phase 1.3.5 left the pipeline ready for a cloud signer; this document closes what can be
verified without paying, and lists precisely what must be confirmed with the vendor before
money moves.

Candidate: **SSL.com OV code-signing certificate + eSigner Tier 1**, ≈ **$309/yr**
($129 OV + $180 eSigner), 240 signing operations per year, 30-day free trial.

## 1. Verified from primary sources (2026-11-03)

| Fact | Status | Source |
| --- | --- | --- |
| CodeSignTool CLI shape: `sign` subcommand, `-username=`, `-password=`, `-totp_secret=`, `-credential_id=`, `-input_file_path=`, `-output_dir_path=` | Confirmed | SSL.com eSigner CodeSignTool Command Guide |
| `-override` is a global parameter, not part of the `sign` synopsis; unnecessary when the output directory is fresh | Confirmed as documented; the adapter no longer passes it | same guide |
| CodeSignTool always timestamps; no CLI flag for TSA or digest. TSA comes from `TSA_URL` in `conf/code_sign_tool.properties` (`http://ts.ssl.com`; `http://ts.ssl.com/legacy` for RSA) | Confirmed | eSigner demo credentials / properties guide |
| `signtool.exe` is **not** required on the CodeSignTool path; no PFX exists for publicly trusted keys | Confirmed | CodeSignTool guide; SSL.com cloud-signing options guide |
| Windows CodeSignTool bundles its own JRE, so `windows-latest` needs no JDK; entry point is `CodeSignTool.bat` | Confirmed | CodeSignTool README / GitHub Actions guide |
| Endpoint is selected with `ENVIRONMENT_NAME=TEST|PROD`, not a second executable | Confirmed | Getting started guide |
| OV $129/yr; eSigner Tier 1 $180/yr for 20 signings/month (240/yr), $1 per extra | Confirmed | SSL.com OV product page; eSigner pricing page |
| Cert validity: CA/B cap is 460 days from 1 Mar 2026; SSL.com enforces 458 days, with free unlimited rekeys/reissues | Confirmed | CA/B Code Signing BRs v3.11.0 §6.3.2; SSL.com OV page |
| OV subject CN is the verified legal organization name | Confirmed by SSL.com `credential_info` sample output | CodeSignTool command guide |
| EV no longer bypasses SmartScreen, so OV is sufficient | Confirmed earlier phase | Microsoft Learn SmartScreen reputation |

## 2. Not verified — ask the vendor before paying

These are the questions the vendor must answer in writing. The first and fourth are the ones
that could make the purchase useless for this pipeline.

1. **India applicant eligibility.** No country restriction is published, but there is no
   affirmative statement either. Ask whether an Indian private limited company can be
   validated, and whether the Government of India MCA/ROC record is accepted as the
   independent information source (SSL.com's documented preference is a D-U-N-S number).
2. **Exact subject/CN.** No self-service preview exists before issuance. Ask for the exact
   subject DN that will be issued, or plan to read it with
   `CodeSignTool credential_info -credential_id=… -username=… -password=…` after issuance and
   before the first release build.
3. **Timestamp token specifics.** SSL.com's TSA is documented as RFC 3161, but no primary
   page states that the CodeSignTool Authenticode token is RFC 3161 with a SHA-256 digest, and
   the default units use ECDSA keys. Ask explicitly, and ask when to use
   `http://ts.ssl.com/legacy` (RSA) instead.
4. **Signing quota and per-file accounting.** Confirm that one `sign` call consumes one
   operation, that a release of four files consumes four, and that unused operations roll over
   while the subscription is active.
5. **CI support.** Confirm headless use from GitHub Actions on a Windows runner with a TOTP
   secret (no interactive OTP), and that TOTP clock skew is the only timing constraint.
6. **Reissue procedure and credential-ID rotation** under the 458-day cap, including whether
   reissue is free and how quickly a replacement credential can sign.
7. **Order callback risk.** The validation includes a callback to the phone number published in
   the registry/D-U-N-S record. Confirm the number that will be called so it is answered.

## 3. Free way to close the CLI unknowns before buying

The vendor publishes sandbox credentials and a sandbox `code_sign_tool.properties` block. That
allows the whole adapter to be exercised before purchase — which is the only way to settle
question 3 without paying:

1. Download CodeSignTool for Windows from SSL.com and unpack it outside the repository.
2. Replace `conf/code_sign_tool.properties` with the sandbox block from SSL.com's demo
   credentials page.
3. Build any unsigned artifact, then:
   `ESIGNER_CLI=<path>\CodeSignTool.bat ESIGNER_SANDBOX=1 ESIGNER_USERNAME=esigner_demo … node scripts/cloud-sign.mjs --file <artifact>`
4. Run `signtool verify /pa /all /v <artifact>` and confirm: signer subject, timestamp present,
   timestamp digest SHA-256, TSA `ts.ssl.com`.
5. Paste that output into §6 below.

This was run on 2026-11-03; the results are in §9.

## 4. After purchase — configuration

No secret ever goes into the repository, a document or a chat message.

1. **Secrets** (repository → Settings → Secrets and variables → Actions → Secrets):
   `ESIGNER_USERNAME`, `ESIGNER_PASSWORD`, `ESIGNER_TOTP_SECRET`, `ESIGNER_CREDENTIAL_ID`.
2. **Variables:** `ISK_SIGN_PROVIDER=esigner`, `ESIGNER_CLI=<path to CodeSignTool.bat>` on the
   runner (the workflow expects it on `PATH` or via this variable). No `ESIGNER_SANDBOX` in the
   release path.
3. **Pin the identity:** set `package.json` → `iskSigning.expectedPublisher` to the certificate
   CN exactly. This is the field that makes the release gate, `app-update.yml` and the running
   updater agree; while it is empty every release build fails closed.
4. Run `node scripts/check-signing-env.mjs` with `ISK_REQUIRE_SIGNING=1` locally, then
   `npm run electron:build` with the eSigner variables set.

## 5. Evidence to collect for Stage C/D (real signing)

Recorded per build, because a PASS without the tool output is not evidence.

- `signtool verify /pa /all /v` on the installer, `win-unpacked\IS King Panel.exe` and
  `resources\runtime\node.exe` (the last must still report **OpenJS Foundation**).
- `Get-AuthenticodeSignature` summary for each: status, signer CN, thumbprint, timestamp.
- `node scripts/verify-signatures.mjs --require` output.
- Installed copy: `npm run verify:signing -- --installed "C:\Program Files\IS King Panel"`,
  which covers `Uninstall IS King Panel.exe`.
- Updater cases: a correctly signed update accepted; an update signed by a different trusted
  certificate rejected (`ERR_UPDATER_INVALID_SIGNATURE`); an `app-update.yml` without
  `publisherName` refused by `updater-policy.cjs`; a tampered installer rejected by hash.

## 6. Signing evidence (fill in when a real certificate exists)

```
Certificate CN:            <pending>
Thumbprint:                <pending>
Credential ID:             <pending>
Issued / expires:          <pending>
Timestamp authority:       <pending>
signtool verify result:    <pending — NOT TESTED>
```

## 7. Cost and volume

| Item | Cost |
| --- | --- |
| OV code-signing certificate, 1 year | $129 |
| eSigner Tier 1, 1 year (240 signings) | $180 |
| **Total** | **≈$309/yr** |

One release signs four files — `IS King Panel.exe`, `elevate.exe`, the NSIS uninstaller and the
installer — so 240 operations is about 60 releases. The bundled `node.exe` is excluded from
signing (`win.signExts: ["!node.exe"]`) and consumes none; overage is $1 per signature.

## 8. Vendor request — send as written

Three answers gate the purchase: India eligibility, the exact subject DN, and whether the
CodeSignTool Authenticode timestamp token is RFC 3161 with SHA-256. Everything else is
commercial.

```
Subject: Pre-purchase confirmation — OV Code Signing + eSigner (India-based publisher)

Hello SSL.com Support Team,

I am preparing to purchase an OV Code Signing certificate with the eSigner cloud signing
service for a Windows desktop application distributed as a signed NSIS installer with a
GitHub-based update feed. Before purchasing, I would appreciate written confirmation of the
following.

1. Applicant eligibility in India
   - Can an India-based software publisher apply for an OV Code Signing certificate?
   - Which legal entity documents are accepted?
   - Can MCA/ROC (Registrar of Companies) registration records be used for organization
     verification, or is a D-U-N-S number required?
   - Are there any additional requirements for an Indian applicant (notarisation, local
     representative, phone verification)?

2. Certificate identity
   - What exact organization name will appear in the certificate subject?
   - Can you provide a preview or sample of the expected Subject Distinguished Name before
     issuance?
   - Will the verified organization name be the certificate CN used for Windows Authenticode
     publisher verification?

3. eSigner technical compatibility
   - Does CodeSignTool support unattended signing from GitHub Actions on windows-latest
     (TOTP secret, no interactive OTP)?
   - Does the Windows CodeSignTool package include its required Java runtime?
   - Can the service sign Windows PE executables, including NSIS installer and uninstaller
     executables, and can it sign a single file four times per release?

4. Timestamping
   - Does the eSigner service use RFC 3161 timestamping for Authenticode signatures?
   - Does the resulting timestamp token use a SHA-256 digest?
   - Is it compatible with Windows `signtool verify /pa /all /v`?
   - Is the timestamp authority fixed to SSL.com's TSA (http://ts.ssl.com), or configurable?
   - When should the legacy RSA endpoint (http://ts.ssl.com/legacy) be used instead of the
     default ECDSA units?

5. Pricing and quota
   - Current annual price for the OV Code Signing certificate and for eSigner Tier 1.
   - Confirm the 240-signing annual quota and that one signing operation is consumed per file.
   - Renewal, rekey and reissue charges, and the process for rotating the credential ID when a
     certificate is reissued under the 458-day validity cap.

I intend to use this certificate for a commercial Windows desktop application and want the
integration and verification requirements satisfied before purchasing.

Thank you.
```

### Decision scorecard

One row per answer. Any `REJECT` blocks the purchase on its own, regardless of price, and the
fallback in the last column is the next step rather than a re-negotiation.

| Question | ACCEPT (buy) | REJECT or escalate | If rejected |
| --- | --- | --- | --- |
| India eligibility | Written confirmation that the applicant entity and its documents are accepted, naming the entity type | Only a marketing page, or “usually works” | DigiCert KeyLocker — evaluate as the alternative cloud OV signer |
| Exact subject DN | The O/OU/CN they will issue, in writing, including whether a CN change forces re-issuance | “The CN is derived automatically” with no value | Ask for a trial certificate's subject, or reject |
| RFC 3161 + SHA-256 | Explicit statement that eSigner timestamps are RFC 3161 with SHA-256 | Silence, or a legacy Authenticode timestamp | Inspect a trial timestamp token for OID `1.2.840.113549.1.9.16.1.4` before paying |
| Quota and price | ≥ 240 signatures/year at ≈ $309 | A quota below the release rate, or a material price increase | eSigner Tier 2, or DigiCert |

`iskSigning.expectedPublisher` stays empty until the exact subject CN is in hand. A guessed pin
fails closed at the first release build — better than a wrong trust anchor, but still a wasted
build, so it is not a shortcut worth taking.

## 9. Sandbox evidence (run 2026-11-03)

CodeSignTool 1.3.2 for Windows, SSL.com sandbox endpoints, the vendor's published demo
account. The file was signed by `scripts/cloud-sign.mjs` itself — not by hand — so the adapter,
the CLI arguments and the post-signing verification are all covered.

| Check | Result |
| --- | --- |
| Adapter → CLI → signed file | works; no `-override` needed |
| Authenticode digest | **sha256** — `Hash of file (sha256): 1342B8…EB080`, one signature index only |
| Nested SHA-1 signature | none |
| Timestamp | present — `The signature is timestamped: Tue Nov 03 11:41:26 2026` |
| Timestamp chain | verified by signtool against `SSL.com Root Certification Authority RSA` → `SSL.com Timestamping Issuing RSA CA 2` → `SSL.com Timestamping Unit 2026 E1` (ECC key), on Windows 10 19045 |
| Signer | `CN=Esigner LLC, O=Esigner LLC, L=Houston, S=Texas, C=US`, algorithm `sha256RSA` |
| Signing chain | `SSL.com EV Code Signing Intermediate CA RSA R2` ← `SSL.com EV Root Certification Authority RSA R2 - Development` |
| WinVerifyTrust | error `0x800B010A` — untrusted root, expected: the sandbox chains to a **development** root that is in no trust store |
| This project's policy on that file | refused (`UnknownError`, “chain could not be built”) — it fails closed exactly as designed |
| Our digest reader on that file | `SHA256` accepted, no SHA-1 |

**What this settles:** the adapter works end to end, produces a SHA-256 Authenticode signature
with a timestamp, and the timestamp chain validates on Windows 10 with SSL.com's ECDSA (`E1`)
timestamp unit — so the “ECDSA units are not compatible” worry does not apply here.

**What it does not settle:** production issuance, the production subject CN, and whether the
timestamp is RFC 3161 or legacy Authenticode format (signtool verifies the timestamp chain but
does not print the protocol). Ask the vendor to confirm RFC 3161 in writing; the practical
requirement — a timestamp that survives certificate expiry — is demonstrated.

Two operational findings from the run are recorded in
[CODE_SIGNING_RUNBOOK.md](CODE_SIGNING_RUNBOOK.md) §10: the Windows package's bundled JDK 11
failed TLS against the sandbox on this machine (system JDK 25 worked), and the tool resolves
`./conf` against the working directory, so the adapter runs it from its own folder.

## 10. What must still not happen

- No release publication from any signed test build: it is a private candidate.
- `ISK_REQUIRE_SIGNING` stays enforced and the pinned publisher stays mandatory.
- No PFX or credential value in git, the installer, logs or documentation.
- Signing evidence from the sandbox must never be presented as production signing.
