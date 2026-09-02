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
// Coarse "how long ago" phrasing for the sync-status footer -- doesn't
// need to be precise to the second, just legible at a glance.
function formatRelativeTime(isoString) {
  const diffMs = Math.max(0, Date.now() - new Date(isoString).getTime());
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return 'just now';
  if (diffMs < hour) {
    const n = Math.floor(diffMs / minute);
    return `${n} minute${n === 1 ? '' : 's'} ago`;
  }
  if (diffMs < day) {
    const n = Math.floor(diffMs / hour);
    return `${n} hour${n === 1 ? '' : 's'} ago`;
  }
  const n = Math.floor(diffMs / day);
  return `${n} day${n === 1 ? '' : 's'} ago`;
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
