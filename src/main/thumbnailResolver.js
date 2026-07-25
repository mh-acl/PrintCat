'use strict';

// thumbnailResolver.js
//
// Ports thumbnail.rb's fallback chain, but generated images are stored
// in the ThumbnailCache (app userData) instead of being written into
// the data git repo.
//
//   Item: explicit thumb.* file -> embedded gcode thumbnail (cached) -> null

const path = require('path');
const { parseGcodeMetadata } = require('./gcodeParser');

class ThumbnailResolver {
  constructor({ thumbnailCache }) {
    this.thumbnailCache = thumbnailCache;
  }

  /**
   * Resolves the thumbnail for one specific print file (e.g. one
   * printer's gcode within an item that has several). Mirrors
   * thumbnail.rb's per-file chain: an override image matching the
   * file's longname, then its shortname, then the file's own embedded
   * gcode thumbnail, then nothing.
   *
   * @param {object} fileEntry  a gcode entry from the indexer (has
   *                            .path, .longname, .shortname, etc.)
   * @param {string[]} imageFiles  image filenames present in the same
   *                            item folder (itemNode.imageFiles)
   */
  async resolveFileThumbnail(fileEntry, imageFiles) {
    const dir = path.dirname(fileEntry.path);
    const byBaseName = new Map(
      imageFiles.map((f) => [path.basename(f, path.extname(f)).toLowerCase(), f])
    );

    const longMatch = byBaseName.get(fileEntry.longname.toLowerCase());
    if (longMatch) return path.join(dir, longMatch);

    const shortMatch = byBaseName.get(fileEntry.shortname.toLowerCase());
    if (shortMatch) return path.join(dir, shortMatch);

    if (!fileEntry.hasEmbeddedThumbnail) return null;

    const key = this.thumbnailCache.keyForGcodeThumbnail(fileEntry);
    if (await this.thumbnailCache.has(key, '.png')) {
      return this.thumbnailCache.filePath(key, '.png');
    }

    const { thumbnailBase64 } = await parseGcodeMetadata(fileEntry.path);
    if (!thumbnailBase64) return null;

    const buffer = Buffer.from(thumbnailBase64, 'base64');
    return this.thumbnailCache.writeBuffer(key, '.png', buffer);
  }

  async resolveItemThumbnail(itemNode) {
    if (itemNode.explicitThumb) {
      return path.join(itemNode.path, itemNode.explicitThumb);
    }

    // Prefer any print file that already resolves to a real thumbnail
    // (override image or embedded), rather than only ever picking the
    // first embedded one -- keeps card thumbnails consistent with
    // whatever the detail view will show for that same file.
    for (const file of itemNode.files) {
      const thumb = await this.resolveFileThumbnail(file, itemNode.imageFiles || []);
      if (thumb) return thumb;
    }
    return null;
  }
}

module.exports = { ThumbnailResolver };
