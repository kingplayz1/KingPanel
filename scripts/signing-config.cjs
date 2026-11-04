/**
 * The provider table, in CommonJS, for the electron-builder config.
 *
 * `scripts/signing.mjs` is the authoritative module, but it is ESM and
 * electron-builder loads its configuration synchronously through `require`.
 * Rather than duplicate the whole policy, this file re-exports the small, stable
 * part the config needs and a test asserts the two agree.
 */
const PROVIDERS = Object.freeze({
  pfx: Object.freeze({
    id: 'pfx',
    credentialVars: Object.freeze(['CSC_LINK', 'CSC_KEY_PASSWORD']),
  }),
  esigner: Object.freeze({
    id: 'esigner',
    credentialVars: Object.freeze([
      'ESIGNER_USERNAME',
      'ESIGNER_PASSWORD',
      'ESIGNER_TOTP_SECRET',
      'ESIGNER_CREDENTIAL_ID',
    ]),
  }),
});

const DEFAULT_TIMESTAMP_SERVER = 'http://timestamp.digicert.com';
const HASH_ALGORITHM = 'sha256';

module.exports = { PROVIDERS, DEFAULT_TIMESTAMP_SERVER, HASH_ALGORITHM };
