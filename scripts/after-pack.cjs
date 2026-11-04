/**
 * electron-builder afterPack hook: check the runtime before the installer exists.
 *
 * `resources/runtime/node.exe` is the official Node build, signed upstream by the
 * OpenJS Foundation. It is NOT re-signed with our certificate: doing so would
 * discard the vendor's signature and assert authorship of a binary we did not
 * build. What must be true instead is that the upstream signature is intact and
 * timestamped — and that is cheap to check here, before NSIS spends a minute
 * compressing 130 MB into an installer nobody should ship.
 *
 * Runs with the same signing environment as electron-builder, so release mode
 * (ISK_REQUIRE_SIGNING=1) aborts the build; a local build only warns.
 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  const { readSignature, checkSignature, signingConfig } = await import('./signing.mjs');
  const pin = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'runtime', 'runtime.json'), 'utf8'),
  );
  const config = signingConfig();

  if (config.problems.length) {
    throw new Error(`Signing configuration is invalid:\n  - ${config.problems.join('\n  - ')}`);
  }
  console.log(
    config.configured
      ? `[signing] certificate configured (${config.method}); electron-builder signs the app and installer`
      : '[signing] no certificate configured — the app and installer will be UNSIGNED',
  );

  const runtimeExe = path.join(context.appOutDir, 'resources', 'runtime', 'node.exe');
  if (!fs.existsSync(runtimeExe)) {
    // The bucket-level runtime check fails later with a clearer message; nothing
    // to sign or verify here.
    return;
  }

  const report = readSignature(runtimeExe);
  const problems = checkSignature({
    label: 'resources/runtime/node.exe',
    report,
    expectedPublisher: pin.publisher,
    requireSigned: true,
    requireTimestamp: true,
  });
  if (problems.length) {
    if (config.requireSigned) {
      throw new Error(
        `The bundled runtime is not signed as expected:\n  - ${problems.join('\n  - ')}\n` +
          'It was not modified by this build; re-fetch it with "npm run runtime:fetch".',
      );
    }
    console.warn(`[signing] upstream runtime signature problem (local build): ${problems.join('; ')}`);
    return;
  }
  console.log(`[signing] runtime: ${report.publisher}, timestamped (upstream signature left intact)`);
};
