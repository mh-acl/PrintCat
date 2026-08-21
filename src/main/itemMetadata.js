'use strict';

// itemMetadata.js
//
// Reads/writes the per-item metadata.json sibling file (schema decided
// in prior discussion -- see ARCHITECTURE.md). This pass only reads
// and writes the item-level displayName/tags fields; per-print-file
// overrides (images, per-file displayName/tags) aren't produced by
// this app yet, but an existing `printFiles` block (however it got
// there) is preserved rather than dropped on the next write, so
// nothing here blocks that from being added later.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const METADATA_FILENAME = 'metadata.json';
const SCHEMA_VERSION = 1;

// Returns null on any failure (missing file, invalid JSON) -- callers
// fall back to filename-derived data in that case, same as if this
// file didn't exist at all.
async function readItemMetadata(itemDir) {
  try {
    const raw = await fsp.readFile(path.join(itemDir, METADATA_FILENAME), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

// Writes displayName/tags, preserving importedAt across edits (set
// once, on the item's first write) and always refreshing
// lastEditedAt. `printFiles`, if given, is a map of
// { [printFileBasename]: { images: string[] } } -- each entry is
// merged onto (not replacing) whatever that print file's existing
// metadata block already held, so a future per-file displayName/tags
// override (not produced by this app yet) wouldn't get clobbered by
// an images-only write.
//
// `origin`, if given, is a partial { url, creatorName, creatorUrl }
// object and is shallow-merged onto whatever origin block already
// existed, same reasoning as printFiles above: the item editor today
// only has a text field for `url` (auto-detected from the item's
// folder -- see originLocation.js -- or typed/cleared by hand), but a
// future pass is expected to fill in `creatorName`/`creatorUrl` by
// scraping the origin page separately. Merging instead of replacing
// means a plain "edit name/tags, leave origin alone" save can't
// accidentally wipe out creator info a later scrape added, and an
// explicit `origin: { url: '' }` (the co-admin clearing the field) still
// takes effect since it overwrites just that key. The whole `origin`
// key is omitted from the written file once none of its three fields
// hold a truthy value, so an item nothing was ever detected/entered
// for doesn't grow an empty placeholder block.
async function writeItemMetadata(itemDir, { displayName, tags, printFiles, origin }) {
  const existing = await readItemMetadata(itemDir);
  const now = new Date().toISOString();

  let mergedPrintFiles = (existing && existing.printFiles) || {};
  if (printFiles) {
    mergedPrintFiles = { ...mergedPrintFiles };
    for (const [filename, fields] of Object.entries(printFiles)) {
      mergedPrintFiles[filename] = { ...(mergedPrintFiles[filename] || {}), ...fields };
    }
  }

  const mergedOrigin = { ...((existing && existing.origin) || {}), ...(origin || {}) };
  const hasOrigin = Object.values(mergedOrigin).some(Boolean);

  const merged = {
    schemaVersion: SCHEMA_VERSION,
    displayName: displayName || '',
    tags: Array.isArray(tags) ? tags : [],
    importedAt: (existing && existing.importedAt) || now,
    lastEditedAt: now,
    ...(Object.keys(mergedPrintFiles).length > 0 ? { printFiles: mergedPrintFiles } : {}),
    ...(hasOrigin ? { origin: mergedOrigin } : {}),
  };

  await fsp.writeFile(path.join(itemDir, METADATA_FILENAME), JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = { readItemMetadata, writeItemMetadata, METADATA_FILENAME };
