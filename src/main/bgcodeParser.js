'use strict';

// bgcodeParser.js
//
// Parses Prusa binary gcode (.bgcode) files, extracting the same
// embedded metadata + thumbnail that gcodeParser.js's parseGcodeMetadata
// extracts from text-based gcode. Format reference:
// https://github.com/prusa3d/libbgcode/blob/main/doc/specifications.md

const fs = require('fs');
const zlib = require('zlib');
const { GcodeCommandScanner } = require('./gcodeCommandScan');
const { scanViaCli } = require('./bgcodeCli');

const MAGIC = 'GCDE';

const BLOCK_TYPE = {
  FILE_METADATA: 0,
  GCODE: 1,
  SLICER_METADATA: 2,
  PRINTER_METADATA: 3,
  PRINT_METADATA: 4,
  THUMBNAIL: 5,
};

// These four block types are all "table of key = value" INI-style
// metadata (same shape the text parser's "; key = value" comments
// produce) and get merged into one flat `values` map. GCode blocks
// hold the actual toolpath; their contents are only opportunistically
// scanned for M600/M486 commands (see BLOCK_TYPE.GCODE handling
// below), never merged into `values`.
const INI_METADATA_BLOCK_TYPES = new Set([
  BLOCK_TYPE.FILE_METADATA,
  BLOCK_TYPE.SLICER_METADATA,
  BLOCK_TYPE.PRINTER_METADATA,
  BLOCK_TYPE.PRINT_METADATA,
]);

// Thumbnail block "Format" param -> mime type, for formats a browser
// can display directly. QOI (format 2) has no native browser support;
// Prusa's bgcode files also include a PNG/JPG thumbnail alongside any
// QOI ones in practice, so QOI-only thumbnails are simply skipped
// rather than converted.
const THUMBNAIL_MIME_BY_FORMAT = { 0: 'image/png', 1: 'image/jpeg' };

// GCode blocks carry their own "Encoding" param on top of the generic
// block Compression field: 0 = None (the gcode text is stored as
// plain ASCII), 1 = MeatPack, 2 = MeatPackComments. MeatPack bit-packs
// common gcode tokens, so a MeatPack-encoded block's bytes aren't
// literal "M600" / "M486 A..." text -- scanning it for those would
// need a MeatPack decoder, which (like Heatshrink -- see
// decompressBlock) this parser deliberately doesn't have.
const GCODE_ENCODING_NONE = 0;

/**
 * Decompresses a block's raw bytes per its "Compression" header field.
 * 0 = none, 1 = Deflate (standard zlib-wrapped stream, confirmed against
 * a real PrusaSlicer-produced file -- not raw/headerless deflate).
 * 2 and 3 are Heatshrink variants, only ever used for GCode blocks in
 * practice, which this parser skips without decompressing.
 */
function decompressBlock(raw, compression) {
  if (compression === 0) return raw;
  if (compression === 1) return zlib.inflateSync(raw);
  throw new Error(`Unsupported bgcode block compression algorithm: ${compression}`);
}

/**
 * Parses "key=value" lines (no surrounding whitespace, unlike the text
 * gcode format's "; key = value" comments) into a flat object.
 */
function parseIniLines(text) {
  const values = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    values[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
  }
  return values;
}

/**
 * Parses a .bgcode file's embedded metadata blocks, thumbnail, and
 * (best-effort) auto-detected color-change/batch/pause info, returning
 * the same `{ values, thumbnailBase64, colorChangeCount, copies,
 * pauseCount, pauseMessages }` shape that parseGcodeMetadata() returns
 * for text-based gcode. If the file's GCode block(s) use a text
 * encoding or compression this parser doesn't decode directly (see
 * BLOCK_TYPE.GCODE handling below), it falls back to the bundled
 * `bgcode` CLI (bgcodeCli.js) to get all four of those fields instead.
 * Only if that fallback also fails do colorChangeCount/copies/pauseCount
 * come back `null` (and pauseMessages `null` too) -- `null` means
 * "couldn't be determined", not "none detected".
 */
async function parseBgcodeMetadata(filePath) {
  const buf = await fs.promises.readFile(filePath);

  if (buf.length < 10 || buf.toString('ascii', 0, 4) !== MAGIC) {
    throw new Error(`Not a valid bgcode file (bad magic number): ${filePath}`);
  }
  const checksumType = buf.readUInt16LE(8); // 0 = none, 1 = CRC32
  const checksumSize = checksumType === 1 ? 4 : 0;

  const values = {};
  let bestThumbnail = null; // { area, width, height, mimeType, base64 }
  const scanner = new GcodeCommandScanner();
  // Set true if any GCode block can't be scanned in-process (MeatPack
  // text encoding, or Heatshrink block compression -- see the
  // constants above). Scanning only some of a file's GCode blocks
  // could undercount color changes or miss batch objects, so if any
  // block is unreadable this way, the whole file's color-change/batch
  // detection is redone via the `bgcode` CLI fallback below rather
  // than trusting a partial in-process count.
  let scanIncomplete = false;

  let offset = 10; // past the file header
  while (offset < buf.length) {
    const type = buf.readUInt16LE(offset);
    const compression = buf.readUInt16LE(offset + 2);
    const uncompressedSize = buf.readUInt32LE(offset + 4);

    let headerSize = 8;
    let compressedSize = uncompressedSize;
    if (compression !== 0) {
      compressedSize = buf.readUInt32LE(offset + 8);
      headerSize = 12;
    }
    const dataSize = compression === 0 ? uncompressedSize : compressedSize;

    // Block parameters: every block type has a 2-byte "encoding" field,
    // except Thumbnail, which has format/width/height (2 bytes each).
    let paramSize = 2;
    let thumbFormat = null, thumbWidth = null, thumbHeight = null;
    if (type === BLOCK_TYPE.THUMBNAIL) {
      thumbFormat = buf.readUInt16LE(offset + headerSize);
      thumbWidth = buf.readUInt16LE(offset + headerSize + 2);
      thumbHeight = buf.readUInt16LE(offset + headerSize + 4);
      paramSize = 6;
    }

    const dataStart = offset + headerSize + paramSize;

    if (INI_METADATA_BLOCK_TYPES.has(type)) {
      const raw = buf.subarray(dataStart, dataStart + dataSize);
      const decompressed = decompressBlock(raw, compression);
      Object.assign(values, parseIniLines(decompressed.toString('utf8')));
    } else if (type === BLOCK_TYPE.THUMBNAIL) {
      const mimeType = THUMBNAIL_MIME_BY_FORMAT[thumbFormat];
      const area = thumbWidth * thumbHeight;
      if (mimeType && (!bestThumbnail || area > bestThumbnail.area)) {
        const raw = buf.subarray(dataStart, dataStart + dataSize);
        const decompressed = decompressBlock(raw, compression);
        bestThumbnail = { area, width: thumbWidth, height: thumbHeight, mimeType, base64: decompressed.toString('base64') };
      }
    } else if (type === BLOCK_TYPE.GCODE) {
      // Unlike metadata/thumbnail blocks, GCode blocks are large and
      // frequently Heatshrink-compressed in practice, so this is the
      // one block type where decompression isn't a given -- only
      // attempt it in-process when both the text encoding and the
      // block compression are ones this parser actually supports
      // (plain text, and none/Deflate respectively). Otherwise mark
      // scanIncomplete so the CLI fallback runs after this loop
      // instead of trusting a partial in-process count.
      const encoding = buf.readUInt16LE(offset + headerSize);
      if (encoding !== GCODE_ENCODING_NONE || (compression !== 0 && compression !== 1)) {
        scanIncomplete = true;
      } else {
        const raw = buf.subarray(dataStart, dataStart + dataSize);
        const decompressed = decompressBlock(raw, compression);
        for (const line of decompressed.toString('utf8').split('\n')) {
          scanner.feedLine(line.trim());
        }
      }
    }
    // Any other/unrecognized block type is intentionally never read
    // here -- we only need its length to skip past it.

    offset = dataStart + dataSize + checksumSize;
  }

  let colorChangeCount, copies, pauseCount, pauseMessages;
  if (scanIncomplete) {
    // At least one GCode block used an encoding/compression this
    // parser can't decode directly -- re-derive color-change/batch/
    // pause info for the whole file via the reference `bgcode` CLI
    // rather than trust a partial in-process scan. Only if the CLI
    // itself fails (missing binary, unexpected error) do we give up
    // and report "unknown", same as before this fallback existed.
    try {
      ({ colorChangeCount, copies, pauseCount, pauseMessages } = await scanViaCli(filePath));
    } catch (err) {
      console.warn(`bgcode CLI fallback failed for ${filePath}: ${err.message}`);
      colorChangeCount = null;
      copies = null;
      pauseCount = null;
      pauseMessages = null;
    }
  } else {
    ({ colorChangeCount, copies, pauseCount, pauseMessages } = scanner.result());
  }

  return {
    values,
    thumbnailBase64: bestThumbnail ? bestThumbnail.base64 : null,
    thumbnailMimeType: bestThumbnail ? bestThumbnail.mimeType : null,
    colorChangeCount,
    copies,
    pauseCount,
    pauseMessages,
  };
}

module.exports = { parseBgcodeMetadata };
