'use strict';

// Small, dependency-free helpers shared across the other renderer
// files (string/number formatting, filename/path helpers, image-ref
// identity). No DOM manipulation, no reference to the shared state in
// state.js.

// Builds a safe file:// URL from an absolute filesystem path. Item and
// print-file names come straight from arbitrary Thingiverse/Printables zip
// downloads and are kept as-is (see ARCHITECTURE.md), so characters like
// "#" or "%" that are meaningful in a URL (fragment marker, percent-escape)
// are entirely plausible in them. Encoding each path segment individually
// -- not the separating slashes -- makes those bytes round-trip as literal
// characters in the path instead of being misread as URL syntax.
function fileUrl(absolutePath) {
  const encoded = absolutePath.split('/').map(encodeURIComponent).join('/');
  return `file://${encoded}`;
}
// Keyword search: splits the query into words and requires all of
// them to appear (in any order, across any of the searched fields) --
// an AND match, not a single-substring match, so "faceted large"
// narrows rather than requiring that exact phrase.
function keywordWords(query) {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}
function textIncludesAllWords(text, words) {
  return words.every((w) => text.includes(w));
}
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
// Coarse "how long ago" phrasing -- used by the sync-status footer and
// (see grid.js's buildItemCardMetaText) the item card's "updated"
// line. Doesn't need to be precise to the second, just legible at a
// glance -- month/year buckets are calendar-approximate (30/365 days)
// for the same reason.
function formatRelativeTime(isoString) {
  const diffMs = Math.max(0, Date.now() - new Date(isoString).getTime());
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const month = 30 * day;
  const year = 365 * day;

  if (diffMs < minute) return 'just now';
  if (diffMs < hour) {
    const n = Math.floor(diffMs / minute);
    return `${n} minute${n === 1 ? '' : 's'} ago`;
  }
  if (diffMs < day) {
    const n = Math.floor(diffMs / hour);
    return `${n} hour${n === 1 ? '' : 's'} ago`;
  }
  if (diffMs < month) {
    const n = Math.floor(diffMs / day);
    return `${n} day${n === 1 ? '' : 's'} ago`;
  }
  if (diffMs < year) {
    const n = Math.floor(diffMs / month);
    return `${n} month${n === 1 ? '' : 's'} ago`;
  }
  const n = Math.floor(diffMs / year);
  return `${n} year${n === 1 ? '' : 's'} ago`;
}
// Parses PrusaSlicer's "estimated printing time (normal mode)" gcode
// comment (e.g. "1h 23m 45s", "23m 45s", "45s", "1d 2h 3m 4s") into
// total seconds. Sums whichever d/h/m/s components are present rather
// than requiring all four, since PrusaSlicer omits leading zero
// components. Returns null when nothing parseable is found (unknown
// printTime, or a raw string in a format we don't recognize) so
// callers can distinguish "no time" from "zero seconds" and exclude
// it rather than let it masquerade as an instant print.
function parsePrintTimeSeconds(raw) {
  if (!raw) return null;
  const d = raw.match(/(\d+)d/);
  const h = raw.match(/(\d+)h/);
  const m = raw.match(/(\d+)m(?!s)/);
  const s = raw.match(/(\d+)s/);
  if (!d && !h && !m && !s) return null;
  return (
    (d ? parseInt(d[1], 10) * 86400 : 0) +
    (h ? parseInt(h[1], 10) * 3600 : 0) +
    (m ? parseInt(m[1], 10) * 60 : 0) +
    (s ? parseInt(s[1], 10) : 0)
  );
}
// Print-time range across a *set of files* -- deliberately takes a
// files array rather than an item, since callers pass different
// filtered subsets of an item's files depending on purpose (grid.js's
// buildItemCardMetaText/sortKeyForItem pass only the files that would
// print on the currently selected printer(s) -- see filesMatchingPrinter
// in filters.js -- not necessarily every file the item has). Files
// with an unparseable/missing printTime are excluded rather than
// treated as 0; returns null (not {min:0,max:0}) when none of the
// given files has a usable printTime at all.
function printTimeRangeSeconds(files) {
  const times = (files || [])
    .map((f) => parsePrintTimeSeconds(f.printTime))
    .filter((t) => t != null);
  if (!times.length) return null;
  return { min: Math.min(...times), max: Math.max(...times) };
}
// The most recent addedAt (see indexer.js's per-file addedAt) among a
// set of files, as epoch ms -- the basis for both the "Recent" sort
// key and the card's "updated" clause (grid.js's sortKeyForItem/
// buildItemCardMetaText), each called with whatever subset of the
// item's files currently counts as "showing" (filters.js's
// filesMatchingCurrentFilters). Files with no addedAt yet (never
// added-to or backfilled) are excluded rather than treated as 0;
// returns null when none of the given files has one.
function latestAddedAtMs(files) {
  const times = (files || [])
    .map((f) => (f.addedAt ? new Date(f.addedAt).getTime() : null))
    .filter((t) => t != null);
  return times.length ? Math.max(...times) : null;
}
// Rounds to the nearest minute (per-second precision isn't meaningful
// for browsing/sorting) and formats as e.g. "45m", "1hr", "1hr 15m".
function formatDurationShort(totalSeconds) {
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}hr`;
  return `${hours}hr ${minutes}m`;
}
function baseNameNoExt(filename) {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? filename : filename.slice(0, idx);
}
// Shared editor for both adding a new item and editing an existing
// one -- see prior design discussion for why these share one form.
// mode is 'add' or 'edit'; item is null for 'add'.
// Strips a print file's printer+extension segment (see the
// name.printer.gcode/.bgcode convention) and then a trailing batch/
// quantity suffix, so "widget.MK4S.bgcode" and
// "widget-batch6.MK4S.bgcode" compare equal for the batch-sharing
// suggestion below.
function strippedBatchName(name) {
  const withoutExt = name.replace(/\.[^.]+\.(gcode|bgcode)$/i, '');
  return withoutExt.replace(/[-_]?(batch\d+|x\d+)$/i, '').toLowerCase();
}
function isImageFileName(name) {
  return /\.(jpe?g|png|gif|svg)$/i.test(name);
}
// Same extension set editSession.js's PRINTFILE_ADD_EXT accepts when
// copying a new print file into an item's folder -- kept in sync
// manually since the renderer has no access to that Node module.
function isPrintFileName(name) {
  return /\.(gcode|bgcode|3mf)$/i.test(name);
}
// "PLA,PLA" -> "PLA"; "PLA,PETG" -> "PLA/PETG". Order of first
// appearance is preserved; a single-material print's one entry
// passes through unchanged.
function formatFilamentTypes(raw) {
  const types = raw.split(',').map((t) => t.trim()).filter(Boolean);
  const unique = [...new Set(types)];
  return unique.join('/');
}
function imageRefSrc(ref, folderPath) {
  return ref.kind === 'existing' ? fileUrl(`${folderPath}/${ref.name}`) : fileUrl(ref.path);
}
function imageRefEquals(a, b) {
  return a.kind === b.kind && (a.kind === 'existing' ? a.name === b.name : a.path === b.path);
}
// A stable string key for a draft's imageCrops map (see
// createDraftFromItem below), distinct from the ref itself since an
// 'external' ref's eventual filename in destDir isn't known client-side
// until editSession.js actually copies it (uniqueDestName may rename
// it on collision) -- so crops are staged against this identity and
// resolved to a final filename server-side, in editSession.js's
// _resolveImageCrops, using the exact same resolvedPathToName map the
// image assignment itself goes through. An 'existing' ref's name is
// already the final filename, so it needs no such resolution -- the
// 'existing:' prefix is stripped back off directly.
function refIdentity(ref) {
  return ref.kind === 'existing' ? `existing:${ref.name}` : `external:${ref.path}`;
}
