'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { run } = require('./gitSync');
const { writeItemMetadata } = require('./itemMetadata');
const { parseFilename, parseGcodeMetadata } = require('./gcodeParser');
const { detectOriginUrl } = require('./originLocation');

// Same extension sets indexer.js uses -- duplicated rather than
// imported since indexer.js doesn't export them, and they're small,
// stable constants.
const GCODE_EXT = new Set(['.gcode', '.bgcode']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.svg', '.gif']);

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch (err) {
    return false;
  }
}

// Picks a filename that doesn't collide with anything already in
// destDir -- used when copying in an image browsed from outside the
// item's folder (see _resolveImages below). "photo.jpg" becomes
// "photo(2).jpg", "photo(3).jpg", etc. on repeated collisions.
async function uniqueDestName(destDir, baseName) {
  let candidate = baseName;
  let n = 2;
  while (await pathExists(path.join(destDir, candidate))) {
    const ext = path.extname(baseName);
    const stem = path.basename(baseName, ext);
    candidate = `${stem}(${n})${ext}`;
    n++;
  }
  return candidate;
}

// One of these exists per active editing session (see main.js's
// enterEditSession()/editSession module-level var) -- null when no
// session is in progress. Tracks pending add/edit/delete changes
// keyed by item folder path, purely for UI display (badges, the
// bottom-bar counts); the actual filesystem mutations for add/edit
// happen immediately (see addItem/editItem below), while delete is
// deferred until confirm() so it stays undoable in the meantime.
//
// Undo-on-cancel doesn't need to reverse each operation individually:
// nothing gets committed to git during a session, so every add/edit
// so far is just uncommitted working-tree state. cancel() below
// restores HEAD and removes untracked files in one step, which undoes
// the whole session regardless of how many operations led up to it.
class EditSession {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.changes = {}; // itemPath -> { type: 'add'|'edit'|'delete', name }
  }

  getChanges() {
    return this.changes;
  }

  // Used when opening the editor in 'add' mode, before anything's been
  // copied into DATA_DIR yet -- lists the print files (with the same
  // colorChangeCount the batch-sharing suggestion needs) and images
  // sitting in the picked source folder, so the editor can show a real
  // print-file list instead of nothing.
  async scanSourceFolder(sourceDir) {
    const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
    const printFiles = [];
    for (const e of entries) {
      if (!e.isFile() || !GCODE_EXT.has(path.extname(e.name).toLowerCase())) continue;
      const { shortname } = parseFilename(e.name);
      const { colorChangeCount, copies } = await parseGcodeMetadata(path.join(sourceDir, e.name));
      printFiles.push({ name: e.name, shortname, colorChangeCount: colorChangeCount ?? null, copies: copies ?? null });
    }
    const imageFiles = entries
      .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name);
    // Reuses the readdir above rather than having originLocation.js
    // list the folder again -- this scan already has the entries it
    // needs.
    const originUrl = await detectOriginUrl(sourceDir, entries);
    return { printFiles, imageFiles, originUrl };
  }

  // Same detection, for 'edit' mode: the item's folder isn't rescanned
  // via scanSourceFolder() there (its print-file/image lists already
  // come from the indexed item itself -- see renderer.js's
  // openItemEditor()), so this is a standalone entry point the editor
  // calls only when the item's metadata.json doesn't already have an
  // origin.url, to avoid re-parsing a Printables PDF every time an
  // already-tagged item is opened for editing.
  async detectOrigin(itemPath) {
    return detectOriginUrl(itemPath);
  }

  // printFileImages is { [printFileBasename]: ImageRef[] }, where each
  // ImageRef is either { kind: 'existing', name } (already a file in
  // destDir) or { kind: 'external', path } (picked via "Browse for
  // images", not yet copied anywhere). Copies every distinct external
  // path into destDir exactly once (so the same external image shared
  // across several print files doesn't get duplicated on disk),
  // resolving collisions against what's already there, and returns a
  // plain { [printFileBasename]: { images: string[] } } map ready for
  // writeItemMetadata's printFiles field.
  async _resolveImages(destDir, printFileImages) {
    if (!printFileImages) return undefined;
    const resolvedPathToName = new Map(); // external path -> final filename in destDir
    const result = {};

    for (const [printFile, refs] of Object.entries(printFileImages)) {
      const names = [];
      for (const ref of refs) {
        if (ref.kind === 'existing') {
          names.push(ref.name);
          continue;
        }
        if (!resolvedPathToName.has(ref.path)) {
          const finalName = await uniqueDestName(destDir, path.basename(ref.path));
          await fsp.copyFile(ref.path, path.join(destDir, finalName));
          resolvedPathToName.set(ref.path, finalName);
        }
        names.push(resolvedPathToName.get(ref.path));
      }
      result[printFile] = { images: names };
    }
    return result;
  }

  async addItem(sourceDir, { name, tags, printFileImages, origin }) {
    const folderName = path.basename(sourceDir);
    const destDir = path.join(this.dataDir, folderName);

    let alreadyExists = true;
    try {
      await fsp.access(destDir);
    } catch (err) {
      alreadyExists = false;
    }
    if (alreadyExists) {
      throw new Error(`"${folderName}" already exists in the catalog.`);
    }

    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.cp(sourceDir, destDir, { recursive: true });
    const resolvedPrintFiles = await this._resolveImages(destDir, printFileImages);
    await writeItemMetadata(destDir, { displayName: name, tags, printFiles: resolvedPrintFiles, origin });

    this.changes[destDir] = { type: 'add', name };
    return this.changes;
  }

  async editItem(itemPath, { name, tags, printFileImages, origin }) {
    // No category anymore, so nothing ever needs to move the item's
    // folder on an edit -- itemPath stays itemPath, only its
    // metadata.json changes.
    const resolvedPrintFiles = await this._resolveImages(itemPath, printFileImages);
    await writeItemMetadata(itemPath, { displayName: name, tags, printFiles: resolvedPrintFiles, origin });

    // An item added earlier this session doesn't exist in the last
    // pushed commit at all -- editing it further is still just
    // refining an add, not a separate "edit" of something that was
    // already live, so the badge should stay "Added" rather than
    // switching to "Edited".
    const wasAdd = this.changes[itemPath] && this.changes[itemPath].type === 'add';
    this.changes[itemPath] = { type: wasAdd ? 'add' : 'edit', name };
    return this.changes;
  }

  // Only marks the item for deletion -- the actual removal is deferred
  // to confirm() below, so it stays visible (greyed out) and undoable
  // via undoDelete() right up until the session is pushed.
  async deleteItem(itemPath) {
    const wasAdd = this.changes[itemPath] && this.changes[itemPath].type === 'add';
    if (wasAdd) {
      // Never existed in the last pushed commit -- deleting it undoes
      // the add outright rather than queuing a separate delete entry.
      await fsp.rm(itemPath, { recursive: true, force: true });
      delete this.changes[itemPath];
      return this.changes;
    }

    const name = (this.changes[itemPath] && this.changes[itemPath].name) || path.basename(itemPath);
    this.changes[itemPath] = { type: 'delete', name };
    return this.changes;
  }

  undoDelete(itemPath) {
    if (this.changes[itemPath] && this.changes[itemPath].type === 'delete') {
      delete this.changes[itemPath];
    }
    return this.changes;
  }

  async cancel(timeoutMs) {
    await run('git', ['checkout', '--', '.'], { cwd: this.dataDir, timeoutMs });
    await run('git', ['clean', '-fd'], { cwd: this.dataDir, timeoutMs });
    this.changes = {};
  }

  // Performs the actual removal for anything marked 'delete' (see
  // deleteItem above), then builds a commit message summarizing every
  // add/edit/delete for the caller to pass to pushNewItem(). Doesn't
  // push itself -- main.js still owns the token/confirm-dialog flow
  // around that, same as the original single-item add flow did.
  async confirm() {
    for (const [itemPath, change] of Object.entries(this.changes)) {
      if (change.type === 'delete') {
        await fsp.rm(itemPath, { recursive: true, force: true });
      }
    }

    const summaryLines = Object.values(this.changes).map((c) => `${c.type}: ${c.name}`);
    const commitMessage =
      summaryLines.length === 1
        ? `Update print catalog: ${summaryLines[0]}`
        : `Update print catalog\n\n${summaryLines.join('\n')}`;

    return { commitMessage };
  }

  clear() {
    this.changes = {};
  }
}

module.exports = { EditSession };
