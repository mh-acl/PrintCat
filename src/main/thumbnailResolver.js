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

// A cached thumbnail's file extension needs to match the actual image
// bytes written into it (see resolveFileThumbnail below) -- a .bgcode
// file's largest embedded thumbnail can be either PNG or JPG (see
// bgcodeParser.js's THUMBNAIL_MIME_BY_FORMAT), so this can't just
// assume '.png' the way it did before thumbnailMimeType existed.
const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg' };

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

    // An explicit metadata.json assignment (see itemMetadata.js /
    // indexer.js's metadataImages) wins over filename-convention
    // matching below -- it's what the co-admin editor actually sets,
    // and should behave predictably regardless of whether filenames
    // happen to also line up. images[0] is the designated
    // primary/thumbnail image per the schema; a future gallery view
    // would show the rest of metadataImages.
    if (fileEntry.metadataImages && fileEntry.metadataImages.length > 0) {
      return path.join(dir, fileEntry.metadataImages[0]);
    }

    const byBaseName = new Map(
      imageFiles.map((f) => [path.basename(f, path.extname(f)).toLowerCase(), f])
    );

    const longMatch = byBaseName.get(fileEntry.longname.toLowerCase());
    if (longMatch) return path.join(dir, longMatch);

    const shortMatch = byBaseName.get(fileEntry.shortname.toLowerCase());
    if (shortMatch) return path.join(dir, shortMatch);

    if (!fileEntry.hasEmbeddedThumbnail) return null;

    // The cache key alone (path+mtime) doesn't say which extension a
    // prior write used -- the source file's actual format could be
    // either PNG or JPG (see EXT_BY_MIME above) -- so check for a hit
    // under both before falling back to re-parsing the source file.
    const key = this.thumbnailCache.keyForGcodeThumbnail(fileEntry);
    for (const ext of Object.values(EXT_BY_MIME)) {
      if (await this.thumbnailCache.has(key, ext)) {
        return this.thumbnailCache.filePath(key, ext);
      }
    }

    const { thumbnailBase64, thumbnailMimeType } = await parseGcodeMetadata(fileEntry.path);
    if (!thumbnailBase64) return null;

    const ext = EXT_BY_MIME[thumbnailMimeType] || '.png';
    const buffer = Buffer.from(thumbnailBase64, 'base64');
    return this.thumbnailCache.writeBuffer(key, ext, buffer);
  }

  async resolveItemThumbnail(itemNode) {
    // An explicit item-level image assignment (set via the item
    // editor, stored as metadata.json's itemImage) wins over the
    // thumb.* filename convention below, mirroring how a per-file
    // metadataImages assignment wins over filename matching in
    // resolveFileThumbnail above -- an explicit co-admin choice should
    // always beat a convention-based guess.
    if (itemNode.metadataItemImage) {
      return path.join(itemNode.path, itemNode.metadataItemImage);
    }

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
