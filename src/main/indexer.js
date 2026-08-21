'use strict';

// indexer.js
//
// Walks the data directory (models/gcode/photos, kept as its own git repo
// separate from the app) and builds a flat array of items -> print files.
// Gcode metadata parsing is the expensive part, so each file's parsed
// result is cached to disk keyed by path + mtime + size; a file is only
// re-parsed when it actually changes.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { parseFilename, parseGcodeMetadata } = require('./gcodeParser');
const { stripTrailingId } = require('./folderName');
const { readItemMetadata } = require('./itemMetadata');

const GCODE_EXT = new Set(['.gcode', '.bgcode']);
const PROJECT_EXT = new Set(['.3mf']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.svg', '.gif']);

// Bump this whenever gcodeParser.js's parsing logic changes in a way
// that would produce different results for already-cached files, OR
// when file paths are about to shift wholesale (e.g. the category
// flatten) -- entries are keyed by absolute path, so a bump here is
// the cheapest way to drop every now-stale entry at once rather than
// leaving them as dead weight until each file's mtime happens to
// change. Otherwise a logic fix (like a filename-parsing bug fix) would
// silently keep serving the old, wrong cached output until a file's
// mtime happens to change.
const CACHE_VERSION = 7;

class Indexer {
  /**
   * @param {string} dataDir   root of the data folder (git repo)
   * @param {string} cacheFile where to persist the parsed-gcode cache (JSON)
   */
  constructor({ dataDir, cacheFile }) {
    this.dataDir = dataDir;
    this.cacheFile = cacheFile;
    this.cache = {}; // filePath -> parsed entry (see _parseGcodeFile)
  }

  async loadCache() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.cacheFile, 'utf8'));
      this.cache = raw.version === CACHE_VERSION ? raw.entries : {};
    } catch (err) {
      this.cache = {}; // no cache yet, or it's corrupt -- start fresh
    }
  }

  async saveCache() {
    await fsp.mkdir(path.dirname(this.cacheFile), { recursive: true });
    await fsp.writeFile(
      this.cacheFile,
      JSON.stringify({ version: CACHE_VERSION, entries: this.cache }, null, 2)
    );
  }

  /**
   * Scans the whole data directory and returns a flat array of items.
   * There's no category concept anymore -- item folders live directly
   * under the data root (or, tolerated for now, nested a level or two
   * deep in whatever's left over from the pre-flatten layout). Tags,
   * from each item's metadata.json, are the only grouping/filtering
   * concept left (see itemMetadata.js and renderer.js).
   */
  async scan() {
    const items = [];
    await this._scanDir(this.dataDir, items);
    await this.saveCache();
    return items;
  }

  async _scanDir(dir, items) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const gcodeFiles = entries.filter(
      (e) => e.isFile() && GCODE_EXT.has(path.extname(e.name).toLowerCase())
    );

    if (gcodeFiles.length > 0) {
      // A folder containing print files directly is an "item" -- this is
      // the folder as unzipped from Thingiverse/Printables, preserved
      // as-is (its original name may hold a source ID we want later).
      const item = await this._buildItem(dir, entries, gcodeFiles);
      items.push(item);
      return;
    }

    // Otherwise this is a grouping folder -- not expected once the
    // data repo is fully flattened, but recursing into it (rather than
    // requiring a strict single level) means a folder someone hasn't
    // gotten around to flattening yet still surfaces its items instead
    // of silently vanishing from the catalog. Skip hidden dirs (.git,
    // etc.).
    const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    for (const sub of subdirs) {
      await this._scanDir(path.join(dir, sub.name), items);
    }
  }

  async _buildItem(dir, entries, gcodeFiles) {
    const projectFiles = entries.filter(
      (e) => e.isFile() && PROJECT_EXT.has(path.extname(e.name).toLowerCase())
    );
    const explicitThumb = this._findExplicitThumb(entries);
    const imageFiles = entries
      .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name);

    const parsedFiles = [];
    for (const f of gcodeFiles) {
      parsedFiles.push(await this._parseGcodeFile(path.join(dir, f.name)));
    }

    const name = path.basename(dir);
    // metadata.json (see itemMetadata.js) overrides the filename-derived
    // display name and adds item-level tags -- a co-admin's edits via
    // the editor take precedence over what's implied by the folder
    // name, but a folder with no metadata.json yet (the old workflow,
    // or one never edited since) still works exactly as before.
    const metadata = await readItemMetadata(dir);
    const metaPrintFiles = (metadata && metadata.printFiles) || {};

    // Per-file image assignments are attached via a shallow copy rather
    // than mutating the cached parse entry directly -- the gcode parse
    // cache (_parseGcodeFile) is keyed off the gcode file's own
    // mtime/size, which has no idea metadata.json even exists, so
    // baking metadataImages into the cached object itself would freeze
    // a stale snapshot into the persisted cache file instead of
    // reflecting metadata.json's actual current content on every scan.
    const files = parsedFiles.map((file) => ({
      ...file,
      metadataImages: (metaPrintFiles[path.basename(file.path)] || {}).images || [],
    }));

    return {
      type: 'item',
      // The original download folder name -- kept verbatim. It's the
      // source of things like the Thingiverse/Printables numeric ID,
      // which we may want to parse out later for a "view original" link.
      name,
      displayName: (metadata && metadata.displayName) || stripTrailingId(name),
      tags: (metadata && metadata.tags) || [],
      // { url, creatorName, creatorUrl } if metadata.json has one,
      // else null. Deliberately not auto-detected here (see
      // originLocation.js) -- that scan (README/PDF parsing) only
      // runs on-demand when the item editor opens, via
      // editSession.js's detectOrigin()/scanSourceFolder(), not on
      // every catalog rescan; baking it into _buildItem() would mean
      // re-reading/re-parsing a PDF on every background rescan for
      // every item that doesn't have metadata.json origin info yet.
      origin: (metadata && metadata.origin) || null,
      path: dir,
      explicitThumb,
      imageFiles, // all images present in this folder, for per-file overrides
      projectFiles: projectFiles.map((f) => path.join(dir, f.name)),
      files,
    };
  }

  _findExplicitThumb(entries) {
    const hit = entries.find(
      (e) =>
        e.isFile() &&
        path.basename(e.name, path.extname(e.name)).toLowerCase() === 'thumb' &&
        IMAGE_EXT.has(path.extname(e.name).toLowerCase())
    );
    return hit ? hit.name : null;
  }

  async _parseGcodeFile(filePath) {
    const stat = await fsp.stat(filePath);
    const cached = this.cache[filePath];
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached;
    }

    const nameInfo = parseFilename(path.basename(filePath));
    const { values, thumbnailBase64, colorChangeCount, copies, pauseCount, pauseMessages, unsupported } =
      await parseGcodeMetadata(filePath);

    const entry = {
      path: filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      shortname: nameInfo.shortname,
      longname: nameInfo.longname,
      tags: nameInfo.tags,
      printerModel: values['printer_model'] || null,
      printerVariant: values['printer_variant'] || null,
      printTime: values['estimated printing time (normal mode)'] || null,
      hasEmbeddedThumbnail: Boolean(thumbnailBase64),
      // Auto-detected (see gcodeCommandScan.js). Any of these three
      // can be `null` for a .bgcode file whose toolpath couldn't be
      // scanned -- that means "unknown", and is distinct from 0/1.
      colorChangeCount: colorChangeCount ?? null,
      copies: copies ?? null,
      pauseCount: pauseCount ?? null,
      // Array of per-pause messages (or null entries), same length as
      // pauseCount; `null` (not []) when pauseCount itself is unknown.
      pauseMessages: pauseMessages ?? null,
      unsupportedFormat: Boolean(unsupported),
    };

    // Cache the parsed entry (without the thumbnail bytes -- those live
    // in the separate thumbnail cache, keyed off this entry's path+mtime).
    this.cache[filePath] = entry;

    // Callers that need the actual thumbnail bytes right after parsing
    // (e.g. to warm the thumbnail cache) can still get them via a
    // dedicated re-read; we don't carry base64 blobs through the JSON
    // cache to keep it small and diffable.
    return entry;
  }
}

module.exports = { Indexer };
