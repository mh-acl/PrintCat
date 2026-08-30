'use strict';

// uniqueFilename.js
//
// Picks a filename that won't collide with anything already present at a
// destination, using "name.1.ext", "name.2.ext", ... suffixes when the
// desired name is already taken. Meant to be shared by every place that
// copies or writes a single file into a location that might already have
// one under that name -- currently drives:saveFile (USB save), and
// eventually the edit-mode "add an image" / "add a print file" flows once
// those exist, so collision handling stays consistent and isn't
// reimplemented per call site.

const path = require('path');

/**
 * @param {string} desiredName  the filename someone actually wants, e.g. "vase.gcode"
 * @param {(candidateName: string) => Promise<boolean>} existsFn  resolves
 *   true if a file/entry with that candidate name already exists at the
 *   destination in question
 * @returns {Promise<string>} desiredName itself if it's free, otherwise the
 *   first "name.N.ext" (N = 1, 2, 3, ...) that isn't taken
 */
async function uniqueFilename(desiredName, existsFn) {
  if (!(await existsFn(desiredName))) return desiredName;

  const ext = path.extname(desiredName);
  const base = desiredName.slice(0, desiredName.length - ext.length);

  for (let n = 1; ; n++) {
    const candidate = `${base}.${n}${ext}`;
    if (!(await existsFn(candidate))) return candidate;
  }
}

module.exports = { uniqueFilename };
