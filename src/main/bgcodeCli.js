'use strict';

// bgcodeCli.js
//
// Fallback path for .bgcode GCode blocks that bgcodeParser.js can't
// decode itself (Heatshrink compression or MeatPack encoding -- see
// bgcodeParser.js's decompressBlock/GCODE_ENCODING_NONE comments).
// Shells out to Prusa's own `bgcode` CLI binary, which decodes every
// compression/encoding variant correctly since it's the reference
// implementation, then hands the resulting plain gcode text to the
// same GcodeCommandScanner used everywhere else in the app.
//
// The bundled `bgcode` binary only supports one invocation shape:
// `bgcode <path>`, which writes a sibling `<name>.gcode` file next to
// its input -- no output-path flag, no stdout mode. To avoid that
// fixed naming colliding with anything (or two concurrent conversions
// stepping on each other during a background rescan), each call gets
// its own throwaway temp directory, and a symlink points the CLI at
// the real file without renaming or copying it (bgcode files can be
// large).

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const { app } = require('electron');
const { GcodeCommandScanner } = require('./gcodeCommandScan');

const execFileP = util.promisify(execFile);

/**
 * Resolves the bundled `bgcode` binary's path. Packaged builds get it
 * from `extraResources` (once packaging is set up -- see
 * ARCHITECTURE.md's "Not yet implemented"); until then, this only
 * needs to handle the dev-time case.
 */
function bgcodeCliPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'bgcode')
    : path.join(__dirname, 'bin', 'bgcode');
}

/**
 * Converts a .bgcode file to plain gcode via the bundled CLI, scans
 * the result for color-change/batch/pause info with a fresh
 * GcodeCommandScanner, and returns the same `{ colorChangeCount,
 * copies, pauseCount, pauseMessages }` shape bgcodeParser.js's own
 * in-process scan produces. Throws on any failure (missing binary,
 * CLI error, unreadable output) -- callers should treat that the same
 * as "still unknown", i.e. no worse off than before this fallback
 * existed.
 */
async function scanViaCli(bgcodeFilePath) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'printcatalog-bgcode-'));
  const linkPath = path.join(tmpDir, 'input.bgcode');
  const outputPath = path.join(tmpDir, 'input.gcode');

  try {
    await fs.symlink(path.resolve(bgcodeFilePath), linkPath);
    await execFileP(bgcodeCliPath(), [linkPath]);
    const text = await fs.readFile(outputPath, 'utf8');

    const scanner = new GcodeCommandScanner();
    for (const line of text.split('\n')) {
      scanner.feedLine(line.trim());
    }
    return scanner.result();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { scanViaCli };
