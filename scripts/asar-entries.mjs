/**
 * Read the file list (and individual files) out of an Electron `app.asar`.
 *
 * Why not `@electron/asar`: it is a transitive dependency of electron-builder,
 * not something this project declares, so a routine dependency bump could remove
 * it and take the release gate with it. The archive format is small and frozen:
 *
 *   [uint32 4][uint32 headerSize]                          <- 8-byte prologue
 *   [uint32 payloadSize][uint32 jsonLength][JSON][padding] <- headerSize bytes
 *   <concatenated file contents>                           <- offsets are relative to here
 *
 * Reading the header is enough for everything the privacy gate needs, and it
 * lets the gate inspect an installed app on a machine with no build tooling.
 */
import fs from 'node:fs';

/** Walk the header tree into forward-slash paths, in a stable order. */
function flatten(node, prefix, out) {
  const files = node?.files;
  if (!files || typeof files !== 'object') return;
  for (const [name, child] of Object.entries(files)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (child && typeof child === 'object' && child.files) {
      flatten(child, rel, out);
      continue;
    }
    out.push({
      path: rel,
      size: Number(child?.size ?? 0),
      offset: typeof child?.offset === 'string' ? Number(child.offset) : null,
      unpacked: Boolean(child?.unpacked),
      executable: Boolean(child?.executable),
    });
  }
}

/**
 * Read the archive header.
 *
 * @param {string} asarPath
 * @returns {{dataOffset: number, entries: Array<{path: string, size: number,
 *   offset: number|null, unpacked: boolean, executable: boolean}>}}
 */
export function readAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const prologue = Buffer.alloc(8);
    if (fs.readSync(fd, prologue, 0, 8, 0) !== 8) {
      throw new Error(`${asarPath} is too short to be an asar archive`);
    }
    const headerSize = prologue.readUInt32LE(4);
    if (headerSize < 8 || headerSize > 64 * 1024 * 1024) {
      throw new Error(`${asarPath} has an implausible asar header size (${headerSize})`);
    }
    const header = Buffer.alloc(headerSize);
    if (fs.readSync(fd, header, 0, headerSize, 8) !== headerSize) {
      throw new Error(`${asarPath} ends inside its asar header`);
    }
    // The header pickle is [payloadSize][stringLength][JSON][padding]. Trusting
    // payloadSize for the JSON slice would swallow the padding, so read the
    // string's own length instead.
    const jsonLength = header.readUInt32LE(4);
    if (jsonLength === 0 || 8 + jsonLength > headerSize) {
      throw new Error(`${asarPath} has an implausible asar header length (${jsonLength})`);
    }
    const json = header.subarray(8, 8 + jsonLength).toString('utf8');
    let tree;
    try {
      tree = JSON.parse(json);
    } catch (err) {
      throw new Error(`${asarPath} header is not JSON: ${err.message}`);
    }
    const entries = [];
    flatten(tree, '', entries);
    return { dataOffset: 8 + headerSize, entries };
  } finally {
    fs.closeSync(fd);
  }
}

/** Just the paths, forward-slash separated. */
export function listAsarEntries(asarPath) {
  return readAsar(asarPath).entries.map((entry) => entry.path);
}

/**
 * Read one file's bytes out of the archive.
 *
 * Used by the privacy gate only on files it already suspects (a `.sqlite` that
 * should never be there), so the cost of a second open per file is irrelevant.
 *
 * @param {string} asarPath
 * @param {string} entryPath
 * @param {{dataOffset?: number, entries?: Array<object>}} [header] reuse a header
 * @returns {Buffer|null} null when the entry is unpacked or absent
 */
export function readAsarEntry(asarPath, entryPath, header) {
  const archive = header && header.entries ? header : readAsar(asarPath);
  const entry = archive.entries.find((candidate) => candidate.path === entryPath);
  if (!entry || entry.unpacked || entry.offset === null) return null;
  const fd = fs.openSync(asarPath, 'r');
  try {
    const buffer = Buffer.alloc(entry.size);
    const read = fs.readSync(fd, buffer, 0, entry.size, archive.dataOffset + entry.offset);
    return read === entry.size ? buffer : null;
  } finally {
    fs.closeSync(fd);
  }
}
