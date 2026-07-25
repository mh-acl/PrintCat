'use strict';

// thumbnailCache.js
//
// Stores generated thumbnails (embedded-gcode extractions) in the
// app's own cache directory -- NOT the data git repo -- so the data
// folder stays source-content-only.
//
// Cache keys are derived from whatever produced the thumbnail (a
// file's path + mtime), so a changed input naturally invalidates the
// old entry -- no separate staleness bookkeeping needed.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

class ThumbnailCache {
  /** @param {string} cacheDir e.g. path.join(app.getPath('userData'), 'thumb-cache') */
  constructor({ cacheDir }) {
    this.cacheDir = cacheDir;
  }

  async ensureDir() {
    await fsp.mkdir(this.cacheDir, { recursive: true });
  }

  _hash(input) {
    return crypto.createHash('sha1').update(input).digest('hex');
  }

  /** Cache key for a thumbnail extracted from a specific gcode file. */
  keyForGcodeThumbnail(gcodeEntry) {
    return this._hash(`gcode:${gcodeEntry.path}:${gcodeEntry.mtimeMs}`);
  }

  filePath(key, ext) {
    return path.join(this.cacheDir, `${key}${ext}`);
  }

  async has(key, ext) {
    try {
      await fsp.access(this.filePath(key, ext));
      return true;
    } catch {
      return false;
    }
  }

  async writeBuffer(key, ext, buffer) {
    await this.ensureDir();
    const filePath = this.filePath(key, ext);
    await fsp.writeFile(filePath, buffer);
    return filePath;
  }
}

module.exports = { ThumbnailCache };
