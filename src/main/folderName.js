'use strict';

// folderName.js
//
// Item (and occasionally category) folder names come straight from an
// unzipped Thingiverse/Printables download and are preserved verbatim
// elsewhere (see indexer.js) since they may hold source metadata files
// we want to parse later (e.g. for a "view original" link).
//
// For display, though, strip the trailing " - <id>[(<n>)]" suffix those
// downloads tack on:
//   "Name of Model - 7861236"     -> "Name of Model"
//   "Name of Model - 7861236(2)"  -> "Name of Model"
//
// The pattern requires a literal space-dash-space immediately before
// the digits, so a name that simply ends in a number -- e.g. "Model of
// Digit 3" -- is left untouched: there's no " - " before the "3".
const TRAILING_ID_RE = /\s-\s\d+(?:\(\d+\))?$/;

function stripTrailingId(name) {
  return name.replace(TRAILING_ID_RE, '').trim();
}

module.exports = { stripTrailingId };
