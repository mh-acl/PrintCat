'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { run } = require('./gitSync');
const { writeItemMetadata } = require('./itemMetadata');
const { parseFilename, parseGcodeMetadata } = require('./gcodeParser');
const { detectOrigin: detectOriginInFolder } = require('./originLocation');

// Same extension sets indexer.js uses -- duplicated rather than
// imported since indexer.js doesn't export them, and they're small,
// stable constants.
const GCODE_EXT = new Set(['.gcode', '.bgcode']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.svg', '.gif']);

// Same thumb.* filename-convention check as indexer.js's private
// _findExplicitThumb -- duplicated (rather than imported off Indexer)
// since it's a small, stable, standalone check on a readdir() result
// this module already has, same reasoning as the extension sets above.
function findExplicitThumb(entries) {
  const hit = entries.find(
    (e) =>
      e.isFile() &&
      path.basename(e.name, path.extname(e.name)).toLowerCase() === 'thumb' &&
      IMAGE_EXT.has(path.extname(e.name).toLowerCase())
  );
  return hit ? hit.name : null;
}

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
      const { shortname, longname } = parseFilename(e.name);
      const { colorChangeCount, copies, values } = await parseGcodeMetadata(path.join(sourceDir, e.name));
      printFiles.push({
        name: e.name,
        shortname,
        // Kept alongside shortname (previously discarded here) so
        // renderer.js's createDraftFromPicked can run the same
        // longname/shortname filename-matching fallback that
        // createDraftFromItem uses for already-catalogued items --
        // otherwise a freshly-added folder with legacy filename-matched
        // images would show broken images in the add-mode editor too.
        longname,
        colorChangeCount: colorChangeCount ?? null,
        copies: copies ?? null,
        // Same two keys indexer.js's _parseGcodeFile reads for the
        // already-catalogued case -- surfaced here too so the 'add'
        // mode editor's file list can show printer/variant next to
        // each file's name the same way 'edit' mode does.
        printerModel: values['printer_model'] || null,
        printerVariant: values['printer_variant'] || null,
      });
    }
    const imageFiles = entries
      .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name);
    // Same thumb.* convention indexer.js checks for already-catalogued
    // items -- without this, a freshly-added folder that relies on
    // that convention (rather than an explicit metadata.json image)
    // would show a broken item thumbnail in the add-mode editor, same
    // bug as the print-file-level one this scan already guards against
    // above via longname.
    const explicitThumb = findExplicitThumb(entries);
    // Reuses the readdir above rather than having originLocation.js
    // list the folder again -- this scan already has the entries it
    // needs. Returns the full { url, creatorName, creatorUrl } object
    // (or null) rather than a bare URL string, so a Printables folder's
    // creator info survives the trip through prepareAddFolder() to the
    // item editor without a second PDF parse.
    const origin = await detectOriginInFolder(sourceDir, entries);
    return { printFiles, imageFiles, explicitThumb, origin };
  }

  // Same detection, for 'edit' mode: the item's folder isn't rescanned
  // via scanSourceFolder() there (its print-file/image lists already
  // come from the indexed item itself -- see renderer.js's
  // openItemEditor()), so this is a standalone entry point the editor
  // calls whenever the item's metadata.json doesn't already have
  // creatorName stored -- including items that already have an
  // origin.url but predate creator extraction -- to avoid re-parsing a
  // Printables PDF for items that have already been fully backfilled.
  // Returns the same { url, creatorName, creatorUrl } shape as
  // scanSourceFolder's origin.
  async detectOrigin(itemPath) {
    return detectOriginInFolder(itemPath);
  }

  // Bulk version of the same per-item backfill the 'edit' editor does
  // on-demand (see detectOrigin above), for catching up every item
  // already in the catalog in one pass rather than requiring each one
  // be opened and saved by hand. `items` is the array indexer.scan()
  // already produces (main.js owns fetching that, so this stays
  // ignorant of the folder-walk logic that lives in indexer.js) --
  // only .path/.displayName/.tags/.origin are read from each entry.
  //
  // Skips (rather than throws on) anything that doesn't need or can't
  // get an update, since one bad/ambiguous folder shouldn't abort the
  // whole batch:
  // - items that already have origin.creatorName are left alone
  //   entirely (nothing to do).
  // - items detection finds nothing usable for are counted as
  //   `notFound` -- same as a single item's on-demand detection
  //   turning up nothing.
  // - items that already have an origin.url on file which DISAGREES
  //   with what a fresh detection finds are counted as `mismatched`
  //   and left untouched, rather than silently swapping in a
  //   different URL out from under a possibly hand-corrected value --
  //   same caution the single-item editor's save-time check applies,
  //   just surfaced as "review these manually" instead of quietly
  //   dropping the creator fields. (An item with no origin.url yet has
  //   nothing to disagree with, so this only ever applies to
  //   already-tagged items.)
  //
  // Each successful update goes through writeItemMetadata with the
  // item's own current displayName/tags passed straight through --
  // writeItemMetadata's displayName/tags fields replace rather than
  // merge (see itemMetadata.js), so omitting them here would blank out
  // any custom name/tags a co-admin had already set, not just leave
  // them untouched.
  async backfillOrigins(items) {
    const updated = [];
    const mismatched = [];
    const notFound = [];

    for (const item of items) {
      if (item.origin && item.origin.creatorName) continue; // already backfilled

      const detected = await detectOriginInFolder(item.path);
      if (!detected || !detected.creatorName) {
        notFound.push(item.displayName);
        continue;
      }
      if (item.origin && item.origin.url && detected.url !== item.origin.url) {
        mismatched.push(item.displayName);
        continue;
      }

      await writeItemMetadata(item.path, {
        displayName: item.displayName,
        tags: item.tags,
        origin: { url: detected.url, creatorName: detected.creatorName, creatorUrl: detected.creatorUrl },
        // Passed through unchanged, same reasoning as displayName/tags
        // above -- writeItemMetadata's itemImage field fully replaces
        // rather than merges (see itemMetadata.js), so omitting it here
        // would silently clear any item-level image a co-admin had
        // already assigned via the editor.
        itemImage: item.metadataItemImage,
      });

      // Marked the same way editItem() marks a change -- 'edit' unless
      // this item was already a pending 'add' this session, in which
      // case it stays 'add' (see editItem's identical comment above).
      const wasAdd = this.changes[item.path] && this.changes[item.path].type === 'add';
      this.changes[item.path] = { type: wasAdd ? 'add' : 'edit', name: item.displayName };
      updated.push(item.displayName);
    }

    return { updated, mismatched, notFound };
  }

  // printFileImages is { [printFileBasename]: ImageRef[] }, where each
  // ImageRef is either { kind: 'existing', name } (already a file in
  // destDir) or { kind: 'external', path } (picked via "Browse for
  // images", not yet copied anywhere). Copies every distinct external
  // path into destDir exactly once (so the same external image shared
  // across several print files -- or shared with the item-level image,
  // see _resolveSingleImageRef below -- doesn't get duplicated on
  // disk), resolving collisions against what's already there, and
  // returns a plain { [printFileBasename]: { images: string[] } } map
  // ready for writeItemMetadata's printFiles field. `resolvedPathToName`
  // is shared with any sibling _resolveSingleImageRef call in the same
  // save so that de-duping.
  async _resolveImages(destDir, printFileImages, resolvedPathToName) {
    if (!printFileImages) return undefined;
    const result = {};

    for (const [printFile, refs] of Object.entries(printFileImages)) {
      const names = [];
      for (const ref of refs) {
        names.push(await this._resolveSingleImageRef(destDir, ref, resolvedPathToName));
      }
      result[printFile] = { images: names };
    }
    return result;
  }

  // Resolves one ImageRef (see _resolveImages above) to its final
  // filename in destDir -- shared helper for both per-print-file image
  // assignment and the single item-level image, so an external image
  // picked for one and reused for the other via the same resolvedPathToName
  // map only gets copied once.
  async _resolveSingleImageRef(destDir, ref, resolvedPathToName) {
    if (ref.kind === 'existing') return ref.name;
    if (!resolvedPathToName.has(ref.path)) {
      const finalName = await uniqueDestName(destDir, path.basename(ref.path));
      await fsp.copyFile(ref.path, path.join(destDir, finalName));
      resolvedPathToName.set(ref.path, finalName);
    }
    return resolvedPathToName.get(ref.path);
  }

  // Folds a { [printFileBasename]: displayName } map into a
  // printFiles object already shaped for writeItemMetadata (e.g. the
  // result of _resolveImages above), merging per-file rather than
  // replacing so a name edit and an image assignment on the same
  // print file don't clobber each other. Returns undefined when
  // there's nothing to write, same convention as _resolveImages.
  _mergePrintFileNames(printFiles, printFileNames) {
    if (!printFileNames) return printFiles;
    const merged = { ...(printFiles || {}) };
    for (const [printFile, displayName] of Object.entries(printFileNames)) {
      merged[printFile] = { ...(merged[printFile] || {}), displayName };
    }
    return merged;
  }

  async addItem(sourceDir, { name, tags, printFileImages, printFileNames, origin, itemImage }) {
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
    const resolvedPathToName = new Map(); // external path -> final filename, shared below
    const resolvedPrintFiles = this._mergePrintFileNames(
      await this._resolveImages(destDir, printFileImages, resolvedPathToName),
      printFileNames
    );
    const resolvedItemImage = itemImage
      ? await this._resolveSingleImageRef(destDir, itemImage, resolvedPathToName)
      : '';
    await writeItemMetadata(destDir, {
      displayName: name,
      tags,
      printFiles: resolvedPrintFiles,
      origin,
      itemImage: resolvedItemImage,
    });

    this.changes[destDir] = { type: 'add', name };
    return this.changes;
  }

  async editItem(itemPath, { name, tags, printFileImages, printFileNames, origin, itemImage }) {
    // No category anymore, so nothing ever needs to move the item's
    // folder on an edit -- itemPath stays itemPath, only its
    // metadata.json changes.
    const resolvedPathToName = new Map(); // external path -> final filename, shared below
    const resolvedPrintFiles = this._mergePrintFileNames(
      await this._resolveImages(itemPath, printFileImages, resolvedPathToName),
      printFileNames
    );
    const resolvedItemImage = itemImage
      ? await this._resolveSingleImageRef(itemPath, itemImage, resolvedPathToName)
      : '';
    await writeItemMetadata(itemPath, {
      displayName: name,
      tags,
      printFiles: resolvedPrintFiles,
      origin,
      itemImage: resolvedItemImage,
    });

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
