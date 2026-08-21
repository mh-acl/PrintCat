'use strict';

// gcodeParser.js
//
// Parses:
//   1. Filenames, to get a display name and tags (two conventions supported)
//   2. The gcode file's own embedded metadata comments + thumbnail
//
// Ported from the original lib/gcode.rb, with the filename convention
// extended to support the newer "name.printer.ext" style alongside the
// legacy "Name (tags)[printer]_uniqueid.ext" style already in the library.

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { parseBgcodeMetadata } = require('./bgcodeParser');
const { GcodeCommandScanner } = require('./gcodeCommandScan');

/**
 * Legacy convention: "Name (tag1, tag2)[printer]_uniqueid.ext" -- but
 * real files in the library have these two annotations in either
 * order (some are "Name [printer](tags)_...", some are
 * "Name (tags)[printer]_..."). Rather than assume one fixed order,
 * strip trailing "(...)" and "[...]" groups one at a time, in
 * whichever order they actually appear, until neither remains at the
 * end of the string.
 *
 * The [printer] bracket's contents are always discarded -- printer
 * identity comes from the gcode file's own embedded metadata
 * (printer_model / printer_variant), not from the filename. The
 * bracket exists purely so multiple sliced files for the same project
 * (one per printer) don't collide on disk.
 */
function parseLegacyName(base) {
  const underscoreIdx = base.indexOf('_');
  if (underscoreIdx === -1) return null; // no trailing suffix -- not legacy style

  let remaining = base.slice(0, underscoreIdx).trim();
  let tags = [];
  let sawAnnotation = false;
  let changed = true;

  while (changed) {
    changed = false;

    const bracketMatch = remaining.match(/\s*\[([^[\]]*)\]$/);
    if (bracketMatch) {
      // printer bracket -- intentionally discarded, see comment above
      remaining = remaining.slice(0, bracketMatch.index).trimEnd();
      sawAnnotation = true;
      changed = true;
      continue;
    }

    const parenMatch = remaining.match(/\s*\(([^()]*)\)$/);
    if (parenMatch) {
      tags = parenMatch[1].split(/\s*,\s*/).filter(Boolean).concat(tags);
      remaining = remaining.slice(0, parenMatch.index).trimEnd();
      sawAnnotation = true;
      changed = true;
      continue;
    }
  }

  if (!remaining) return null; // annotations ate the whole string -- bail out

  return {
    convention: 'legacy',
    shortname: remaining,
    longname: tags.length ? `${remaining} (${tags.join(', ')})` : remaining,
    tags,
  };
}

/**
 * New convention: "name.printer.ext"
 * The printer segment (the last dot-separated part before the
 * extension) is a pure disambiguator for one-file-per-printer siblings.
 * It is NOT parsed as metadata -- same reasoning as the legacy bracket.
 */
function parseDottedName(base) {
  const dotIdx = base.lastIndexOf('.');
  const shortname = dotIdx === -1 ? base : base.slice(0, dotIdx);
  return {
    convention: 'dotted',
    shortname: shortname.trim(),
    longname: shortname.trim(),
    tags: [], // tags aren't part of this convention -- see README note
    // whatever followed the last '.' (the printer slug) is discarded.
  };
}

/**
 * Parses a print file's filename into a display name + tags.
 * Tries the legacy convention first (it requires an underscore
 * uniqueid, which the new convention never has), then falls back to
 * the dotted convention.
 */
function parseFilename(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);

  if (base.includes('_')) {
    const legacy = parseLegacyName(base);
    if (legacy) return legacy;
  }

  return parseDottedName(base);
}

/**
 * Reads a gcode file's embedded metadata, thumbnail (if present), and
 * auto-detected color-change/batch/pause info. Transparently supports
 * both text-based gcode (streamed line-by-line so large files don't
 * need to be loaded fully into memory, reading "; key = value" header
 * comments) and Prusa binary gcode / .bgcode (parsed block-by-block
 * per the format's own spec). Both return the same
 * `{ values, thumbnailBase64, thumbnailMimeType, colorChangeCount,
 * copies, pauseCount, pauseMessages }` shape regardless of which
 * format was on disk:
 *   - thumbnailMimeType: mime type of thumbnailBase64's bytes ('image/png'
 *     or 'image/jpeg'), or null when thumbnailBase64 is null. Text-based
 *     gcode's "thumbnail begin/end" convention is PNG-only, so this is
 *     always 'image/png' whenever a thumbnail is present; .bgcode can be
 *     either, since it picks the largest of a PNG or JPG thumbnail block
 *     (see bgcodeParser.js) -- callers that write the thumbnail bytes to
 *     disk (thumbnailResolver.js) need this to pick a matching file
 *     extension rather than assuming PNG.
 *   - colorChangeCount: number of M600 commands found.
 *   - copies: detected batch size from M486-declared object names
 *     (1 if no batch was detected).
 *   - pauseCount: number of M601 commands found.
 *   - pauseMessages: array, one entry per pause, of the M117 message
 *     that immediately preceded that M601 (`null` where there wasn't
 *     one).
 * For .bgcode specifically, colorChangeCount/copies/pauseCount can come
 * back `null` instead of a number (and pauseMessages `null` too) if the
 * file's embedded toolpath couldn't be scanned (see bgcodeParser.js) --
 * `null` means "unknown", not "zero"/"one"/"none".
 */
async function parseGcodeMetadata(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.bgcode') {
    return parseBgcodeMetadata(filePath);
  }

  const values = {};
  let thumbnailBase64 = null;
  let inThumbnail = false;
  let thumbChunks = [];
  const scanner = new GcodeCommandScanner();

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    const line = rawLine.trim();

    if (!inThumbnail && line.includes('thumbnail begin')) {
      inThumbnail = true;
      thumbChunks = [];
      continue;
    }
    if (inThumbnail) {
      if (line.includes('thumbnail end')) {
        inThumbnail = false;
        thumbnailBase64 = thumbChunks.join('');
      } else {
        const match = line.match(/[a-zA-Z0-9/+=]+/);
        if (match) thumbChunks.push(match[0]);
      }
      continue;
    }
    const kv = line.match(/^; (.+) = ([^\n]+)$/);
    if (kv) {
      values[kv[1]] = kv[2];
      continue;
    }
    // Not a thumbnail chunk or a "; key = value" settings comment, so
    // it's either an actual command or a plain comment -- either way,
    // safe to hand to the scanner (M600/M486 checks won't match a
    // comment line, since those all start with "; ").
    scanner.feedLine(line);
  }

  return {
    values,
    thumbnailBase64,
    // Text gcode's "thumbnail begin/end" convention is PNG-only --
    // see the doc comment above -- so this is always 'image/png'
    // whenever a thumbnail was actually found, null otherwise.
    thumbnailMimeType: thumbnailBase64 ? 'image/png' : null,
    ...scanner.result(),
  };
}

module.exports = { parseFilename, parseGcodeMetadata };
