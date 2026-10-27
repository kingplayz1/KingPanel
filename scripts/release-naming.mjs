/**
 * The artifact names for a Windows release, derived from `build.win.artifactName`
 * in package.json.
 *
 * Both the build (scripts/build-release.mjs) and the publish check
 * (scripts/release-assets.mjs) ask this module for the names instead of each
 * spelling them out. That is the point: an installer called one thing on disk
 * while latest.yml points at another is precisely the bug that makes
 * electron-updater download a 404, and it cannot happen if there is only one
 * place the name is computed.
 */

/** electron-updater's Windows feed filename; fixed by the updater, not by us. */
export const LATEST_YML = 'latest.yml';

export function substituteArtifactName(template, { version, productName, name }) {
  const allowed = new Set(['version', 'ext', 'productName', 'name']);
  for (const [, key] of template.matchAll(/\$\{([^}]+)\}/g)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Unsupported placeholder \${${key}} in build.win.artifactName; ` +
          `supported: ${[...allowed].map((k) => `\${${k}}`).join(', ')}`,
      );
    }
  }
  return template
    .replaceAll('${version}', version)
    .replaceAll('${productName}', productName)
    .replaceAll('${name}', name)
    .replaceAll('${ext}', 'exe');
}

/**
 * @param {object} pkg parsed package.json
 * @returns {{version: string, installer: string, blockmap: string, latestYml: string}}
 */
export function resolveReleaseAssets(pkg) {
  const version = pkg?.version;
  if (!version) {
    throw new Error('package.json has no version; a release cannot be identified.');
  }

  const template = pkg.build?.win?.artifactName;
  if (!template) {
    throw new Error(
      'build.win.artifactName is not set in package.json. Without it the installer ' +
        'name contains spaces while latest.yml references a hyphenated name, which ' +
        'breaks updates.',
    );
  }

  const installer = substituteArtifactName(template, {
    version,
    productName: pkg.build?.productName ?? pkg.name,
    name: pkg.name,
  });

  return {
    version,
    installer,
    blockmap: `${installer}.blockmap`,
    latestYml: LATEST_YML,
  };
}
