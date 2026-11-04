/**
 * Who may update this installation?
 *
 * electron-updater's NSIS updater verifies the downloaded installer with
 * `Get-AuthenticodeSignature` and compares the signing certificate against
 * `publisherName` from `resources/app-update.yml`. The catch, visible in
 * electron-updater/out/NsisUpdater.js, is that when `publisherName` is absent it
 * `return null`s — verification is *skipped*, not failed. The hash check from
 * latest.yml still applies, but any certificate would then be accepted.
 *
 * So the trust decision is made here, in the application, from two facts:
 * the identity compiled into this build (package.json `iskSigning`) and the
 * identity the packaged feed declares. Either missing or disagreeing means no
 * update check at all: a build that cannot verify a publisher must not install
 * one.
 *
 * Pure functions, no Electron imports, so it can be tested directly.
 */

/** CN from a certificate subject such as `CN=Acme Ltd, O=Acme Ltd, C=AU`. */
function publisherName(subject) {
  if (!subject) return '';
  const match = /(?:^|,\s*)CN=("[^"]+"|[^,]+)/i.exec(String(subject));
  return match ? match[1].replace(/^"|"$/g, '').trim() : '';
}

/** `publisherName` may be a string or an array of DNs; normalise to a list. */
function publisherList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry ?? '').trim()).filter(Boolean);
  const single = String(value ?? '').trim();
  return single ? [single] : [];
}

/**
 * Decide whether this installation may check for (and install) updates.
 *
 * @param {{appUpdate?: Record<string, unknown>, expectedPublisher?: string}} options
 * @returns {{allowed: boolean, problems: string[], expected: string, declared: string[]}}
 */
function evaluateUpdaterPolicy({ appUpdate, expectedPublisher }) {
  const expected = String(expectedPublisher ?? '').trim();
  const declared = publisherList(appUpdate?.publisherName);
  const problems = [];

  if (!expected) {
    problems.push(
      'this build pins no publisher (package.json iskSigning.expectedPublisher), so a downloaded installer cannot be checked against an identity',
    );
  }
  if (declared.length === 0) {
    problems.push(
      'app-update.yml has no publisherName, so electron-updater would skip signature verification of every downloaded installer',
    );
  }
  if (expected && declared.length > 0) {
    const match = declared.some(
      (entry) => entry.toLowerCase() === expected.toLowerCase() || publisherName(entry).toLowerCase() === expected.toLowerCase(),
    );
    if (!match) {
      problems.push(
        `app-update.yml expects publisher "${declared.join(' | ')}" but this build pins "${expected}"`,
      );
    }
  }

  return { allowed: problems.length === 0, problems, expected, declared };
}

module.exports = { evaluateUpdaterPolicy, publisherList, publisherName };
