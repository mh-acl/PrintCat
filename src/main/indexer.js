'use strict';

// indexer.js
//
// Walks the data directory (models/gcode/photos, kept as its own git repo
// separate from the app) and builds a tree of categories -> items -> print
// files. Gcode metadata parsing is the expensive part, so each file's
// parsed result is cached to disk keyed by path + mtime + size; a file is
// only re-parsed when it actually changes.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { parseFilename, parseGcodeMetadata } = require('./gcodeParser');
const { stripTrailingId } = require('./folderName');

const GCODE_EXT = new Set(['.gcode', '.bgcode']);
const PROJECT_EXT = new Set(['.3mf']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.svg', '.gif']);

// Bump this whenever gcodeParser.js's parsing logic changes in a way
// that would produce different results for already-cached files --
// otherwise a logic fix (like a filename-parsing bug fix) would
// silently keep serving the old, wrong cached output until a file's
// mtime happens to change.
const CACHE_VERSION = 6;

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
   * Categories are no longer a nested tree -- each item is tagged with
   * `category`, the name of whichever top-level folder it sits under
   * (however deeply nested inside that folder), or null if it's
   * directly at the data root. This trades away arbitrary category
   * nesting for a much simpler, tag-like filtering model.
   */
  async scan() {
    const items = [];
    await this._scanDir(this.dataDir, null, items);
    await this.saveCache();
    return items;
  }

  async _scanDir(dir, category, items) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const gcodeFiles = entries.filter(
      (e) => e.isFile() && GCODE_EXT.has(path.extname(e.name).toLowerCase())
    );

    if (gcodeFiles.length > 0) {
      // A folder containing print files directly is an "item" -- this is
      // the folder as unzipped from Thingiverse/Printables, preserved
      // as-is (its original name may hold a source ID we want later).
      const item = await this._buildItem(dir, entries, gcodeFiles);
      item.category = category;
      items.push(item);
      return;
    }

    // Otherwise this is a grouping folder. Skip hidden ones (.git,
    // etc.). Only assign a NEW category name when we're still at the
    // true root (category === null) -- once inside a category, any
    // further nesting just keeps flattening into that same category
    // rather than creating a subcategory.
    const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    for (const sub of subdirs) {
      const childPath = path.join(dir, sub.name);
      const nextCategory = category === null ? sub.name : category;
      await this._scanDir(childPath, nextCategory, items);
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

    const files = [];
    for (const f of gcodeFiles) {
      files.push(await this._parseGcodeFile(path.join(dir, f.name)));
    }

    const name = path.basename(dir);
    return {
      type: 'item',
      // The original download folder name -- kept verbatim. It's the
      // source of things like the Thingiverse/Printables numeric ID,
      // which we may want to parse out later for a "view original" link.
      name,
      displayName: stripTrailingId(name), // cleaned name for the UI
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
