/**
 * KingPanel brand — the single source of truth for the product identity in the
 * renderer. Import from here instead of retyping the name, so the panel cannot
 * drift back into "IS King Panel" / "IS King Server Panel" / "King Control
 * Panel" mixtures.
 *
 * Deliberately NOT here (these are frozen identifiers, not branding):
 * - `productName`, `appId`, the NSIS artifact/shortcut names in package.json —
 *   they decide the install directory, `%APPDATA%\<productName>` userData and
 *   electron-updater's app identity.
 * - The `KingServers` data folder, the firewall rule prefix
 *   (`IS King Panel Forward`, keyed by name so existing rules stay manageable)
 *   and the Discord bot/guild identity.
 * Renaming any of those would orphan data or break updates for installed users.
 */

export const BRAND = {
  /** Product name: one word, two capitals. */
  name: 'KingPanel',
  /** Wordmark split — the crest's gold paints the tail half. */
  wordmark: { lead: 'King', tail: 'Panel' },
  /** What the product is; used as the tagline and in window/document titles. */
  descriptor: 'Minecraft Server Control Panel',
} as const;

/** Document/window title. Mirrored literally in index.html and electron-main.cjs. */
export const WINDOW_TITLE = `${BRAND.name} — ${BRAND.descriptor}`;
