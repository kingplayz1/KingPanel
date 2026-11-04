/**
 * electron-builder hook: hand one artifact to the cloud signer.
 *
 * electron-builder resolves `win.signtoolOptions.sign` from a file path and calls
 * the exported function once per artifact and digest (see
 * app-builder-lib/out/codeSign/windowsSignToolManager.js). This file is only
 * wired in when ISK_SIGN_PROVIDER=esigner (scripts/electron-builder.config.cjs);
 * the PFX path keeps using electron-builder's own signtool invocation.
 *
 * The signing work lives in scripts/cloud-sign.mjs so the same code can be run by
 * hand against a single executable.
 */
module.exports = async function cloudSignHook(configuration) {
  const { signWithProvider } = await import('./cloud-sign.mjs');
  const file = configuration?.path;
  if (!file) {
    throw new Error('cloud signing hook was called without a file path');
  }

  // electron-builder signs every .exe in the app directory (winPackager.js
  // shouldSignFile falls back to `isExe`), which includes the bundled Node
  // runtime. Signing it would replace the OpenJS Foundation signature with ours:
  // untrue, and it burns a paid eSigner quota credit per build. The exclusion in
  // package.json (win.signExts) is the real fix; this is the belt to that braces,
  // because a silent overwrite is exactly the kind of thing a build log hides.
  if (/[\\/]resources[\\/]runtime[\\/]/i.test(file)) {
    throw new Error(
      `refusing to sign ${file}: the bundled Node runtime must keep its upstream ` +
        'OpenJS Foundation signature (win.signExts should exclude node.exe)',
    );
  }
  const expectedDigest = String(configuration?.hash ?? '').toLowerCase();
  if (expectedDigest && expectedDigest !== 'sha256') {
    throw new Error(
      `cloud signing refuses a "${expectedDigest}" signature: this project signs SHA-256 only ` +
        '(win.signtoolOptions.signingHashAlgorithms)',
    );
  }
  await signWithProvider(file);
  return true;
};
