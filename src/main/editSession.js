'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { run } = require('./gitSync');
const { writeItemMetadata, METADATA_FILENAME } = require('./itemMetadata');
const { parseFilename, parseGcodeMetadata } = require('./gcodeParser');
const { detectOrigin: detectOriginInFolder } = require('./originLocation');
const { uniqueFilename } = require('./uniqueFilename');
const { isShallowRepo, unshallowRepo, computeAddedDate, computeAddedDateForFile } = require('./dateBackfill');

// Per-item git log call is fast (one small subprocess), but a repo
// that's never been unshallowed before needs one much longer fetch
// first -- see dateBackfill.js's isShallowRepo/unshallowRepo.
const GIT_LOG_TIMEOUT_MS = 15 * 1000;
const UNSHALLOW_TIMEOUT_MS = 5 * 60 * 1000;

// Same extension sets indexer.js uses -- duplicated rather than
// imported since indexer.js doesn't export them, and they're small,
// stable constants.
const GCODE_EXT = new Set(['.gcode', '.bgcode']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.svg', '.gif']);

// GitHub hard-rejects any single blob at or above 100MB at
// receive-pack -- server-side, unconditionally, regardless of client
// settings like http.postBuffer. Caught here (before a folder is ever
// copied into DATA_DIR or an existing item's folder is touched) so an
// oversized file never gets git-added/committed in the first place --
// once committed, it's stuck in local history and neither
// EditSession.cancel() (which only reverts uncommitted/untracked
// state) nor a retried push can undo it. Mirrored as a second,
// defensive check in gitPush.js right before the actual commit, in
// case a file lands in an item's folder some other way (e.g. dropped
// in via Finder after this editor session already scanned it).
const MAX_FILE_BYTES = 100 * 1024 * 1024;

// Recursively walks `dir` and returns { relPath, size } for every file
// at or above limitBytes. relPath is relative to `dir` (not the full
// path) so callers can report a filename the co-admin actually
// recognizes rather than an absolute path buried inside DATA_DIR.
async function findOversizedFiles(dir, limitBytes) {
  const oversized = [];
  async function walk(currentDir, relPrefix) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(fullPath);
        if (stat.size >= limitBytes) {
          oversized.push({ relPath, size: stat.size });
        }
      }
    }
  }
  await walk(dir, '');
  return oversized;
}

// Shared error message for both this file's checks and gitPush.js's --
// names every offending file (with its size) rather than just saying
// "a file is too big", since with multiple print files in one item
// folder the co-admin needs to know which one to remove or compress.
function oversizedFilesMessage(oversized, limitBytes) {
  const limitMb = Math.floor(limitBytes / (1024 * 1024));
  const lines = oversized
    .map((f) => `  - ${f.relPath} (${(f.size / (1024 * 1024)).toFixed(1)} MB)`)
    .join('\n');
  return (
    `The following file(s) are at or above GitHub's ${limitMb}MB per-file limit and can't be added:\n` +
    `${lines}\n\nRemove or compress them and try again.`
  );
}

// Files worth keeping once an item's origin is verified (see
// hasVerifiedOrigin/pruneToEssentialFiles below): the print-ready
// outputs (.3mf/.gcode/.bgcode -- same sets indexer.js actually reads),
// the images, and text/PDF docs (since that's often where
// originLocation.js's own detection reads the source URL from, e.g. a
// Printables info PDF or a Thingiverse readme). Everything else at the
// item's top level -- source .stl/.step/.obj meshes, zip-original
// license/readme dupes, anything else that rode along in the original
// download -- plus every subfolder outright, gets dropped once an item
// reaches this stage. metadata.json itself is always kept regardless
// of this list (see pruneToEssentialFiles).
const PROJECT_EXT = new Set(['.3mf']);
const DOC_EXT = new Set(['.txt', '.pdf']);
const KEEP_EXT = new Set([...GCODE_EXT, ...PROJECT_EXT, ...DOC_EXT, ...IMAGE_EXT]);

// "Verified" here means detectOrigin actually resolved a creator, not
// just a bare guessed URL -- same bar backfillOrigins already uses to
// decide an item doesn't need re-detecting. Takes the *merged* object
// writeItemMetadata returns (not the raw origin argument callers pass
// in) because writeItemMetadata shallow-merges origin onto whatever
// was already on file -- an edit that only touches name/tags, leaving
// `origin` undefined, can still land on an item whose existing
// metadata already carries a full verified origin from an earlier
// backfill pass, and that item should still get pruned on this save.
function hasVerifiedOrigin(mergedMetadata) {
  const origin = mergedMetadata && mergedMetadata.origin;
  return Boolean(origin && origin.url && origin.creatorName);
}

// Strips itemDir down to just the KEEP_EXT files (plus metadata.json)
// at its top level, deleting every subfolder outright. Only ever
// called once an item's origin is verified (see hasVerifiedOrigin) --
// the origin URL becomes the fallback way to recover the original
// source model later, in place of keeping it in this repo. This is a
// one-way trim: it only prunes the folder as it stands *right now*,
// during this add/edit -- it doesn't touch git history, so space
// already spent on a since-pruned item's old files needs a separate
// one-time history rewrite (git filter-repo or similar) to actually
// reclaim.
async function pruneToEssentialFiles(itemDir) {
  const entries = await fsp.readdir(itemDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(itemDir, entry.name);
    if (entry.isDirectory()) {
      await fsp.rm(fullPath, { recursive: true, force: true });
      continue;
    }
    if (entry.name === METADATA_FILENAME) continue;
    if (KEEP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    await fsp.rm(fullPath, { force: true });
  }
}

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

// Extensions accepted when adding new print files to an existing item
// in edit mode (see _resolveNewPrintFiles below) -- the two indexer.js
// treats as an actual "print file" card (.gcode/.bgcode) plus the
// .3mf project file some items keep alongside them. Kept as its own
// set (not reusing GCODE_EXT above) since a bare gcode/bgcode-only set
// would silently reject a dropped .3mf.
const PRINTFILE_ADD_EXT = new Set(['.gcode', '.bgcode', '.3mf']);

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
  constructor(dataDir, syncToken) {
    this.dataDir = dataDir;
    this.changes = {}; // itemPath -> { type: 'add'|'edit'|'delete', name }
    // Fetched once, at entry (see main.js's enterEditSession()), via the
    // native macOS admin-auth prompt -- held here for the lifetime of
    // this session so confirmSession() can push without prompting a
    // second time. Never sent to the renderer (same rule as before).
    this.syncToken = syncToken;
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
      // Tagged with the same `bulk` marker backfillAddedDates uses, so
      // confirm() folds a whole-catalog run into one commit-message
      // line instead of one per item -- unless a real edit already
      // touched this item earlier in the session, in which case that
      // stays its own line (see backfillAddedDates' identical logic).
      const existing = this.changes[item.path];
      let changeEntry;
      if (existing && existing.type === 'add') {
        changeEntry = { type: 'add', name: item.displayName };
      } else if (existing && existing.type === 'edit' && !existing.bulk) {
        changeEntry = { type: 'edit', name: item.displayName };
      } else {
        changeEntry = { type: 'edit', name: item.displayName, bulk: 'backfillOrigins' };
      }
      this.changes[item.path] = changeEntry;
      updated.push(item.displayName);
    }

    return { updated, mismatched, notFound };
  }

  // One-off catch-up recomputing importedAt (see itemMetadata.js) for
  // every item passed in, and each of its print files' own addedAt
  // (see itemMetadata.js's printFiles map), via dateBackfill.js's
  // git+filesystem heuristic -- see main.js's Tools-menu wiring for
  // why this exists. Unlike backfillOrigins above, this deliberately
  // does NOT skip items/files that already have a value: an existing
  // importedAt/addedAt may just be a "first time this app touched it"
  // artifact (writeItemMetadata/the add-time stamping in
  // _resolveNewPrintFiles/addItem only fill it in if missing -- see
  // itemMetadata.js) rather than a trustworthy add date, so every
  // item and file gets recomputed. Safe to re-run -- the heuristic
  // converges on the same answer each time for a given item/file,
  // since it only depends on git history and file mtimes, neither of
  // which this backfill itself changes.
  //
  // Unshallows the local data-repo clone first if needed (see
  // dateBackfill.js) -- a one-time, permanent side effect on whichever
  // laptop runs this, accepted as the cost of getting real git history
  // to check against.
  async backfillAddedDates(items) {
    if (await isShallowRepo(this.dataDir, GIT_LOG_TIMEOUT_MS)) {
      await unshallowRepo(this.dataDir, UNSHALLOW_TIMEOUT_MS);
    }

    const results = [];
    for (const item of items) {
      const { date, source } = await computeAddedDate(item.path, this.dataDir, GIT_LOG_TIMEOUT_MS);

      // One computeAddedDateForFile call per print file, folded into
      // the same printFiles map shape writeItemMetadata expects
      // (merged onto, not replacing, any existing per-file
      // displayName/images override -- see itemMetadata.js). filesDated
      // is just for the per-item result summary below, not written
      // anywhere itself.
      const printFiles = {};
      let filesDated = 0;
      for (const file of item.files || []) {
        const fileResult = await computeAddedDateForFile(file.path, this.dataDir, GIT_LOG_TIMEOUT_MS);
        printFiles[path.basename(file.path)] = { addedAt: fileResult.date };
        filesDated++;
      }

      // displayName/tags/itemImage passed through unchanged -- same
      // reasoning as backfillOrigins above, since writeItemMetadata
      // fully replaces (rather than merges) those three fields.
      await writeItemMetadata(item.path, {
        displayName: item.displayName,
        tags: item.tags,
        itemImage: item.metadataItemImage,
        importedAt: date,
        printFiles,
      });

      // Same type-preservation rule as backfillOrigins above: stays
      // 'add' if this item was already a pending add this session,
      // otherwise marked 'edit' -- no separate change-type vocabulary
      // for this, so it shows up in the ordinary Edited count/badge.
      // The extra `bulk` marker (edit-only -- an 'add' this session
      // doesn't need grouping, there's rarely more than a couple) is
      // just for confirm()'s commit-message builder, which folds every
      // same-`bulk` change into one summary line instead of listing
      // each item -- a whole-catalog backfill would otherwise produce
      // a commit message hundreds of lines long.
      const existing = this.changes[item.path];
      let changeEntry;
      if (existing && existing.type === 'add') {
        changeEntry = { type: 'add', name: item.displayName };
      } else if (existing && existing.type === 'edit' && !existing.bulk) {
        // A real edit already happened to this item earlier in the
        // session -- keep it as its own commit-message line rather
        // than folding it into the bulk summary below.
        changeEntry = { type: 'edit', name: item.displayName };
      } else {
        changeEntry = { type: 'edit', name: item.displayName, bulk: 'backfillAddedDates' };
      }
      this.changes[item.path] = changeEntry;
      results.push({ name: item.displayName, date, source, filesDated });
    }

    return results;
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
      const finalName = await uniqueFilename(path.basename(ref.path), (candidate) =>
        pathExists(path.join(destDir, candidate))
      );
      await fsp.copyFile(ref.path, path.join(destDir, finalName));
      resolvedPathToName.set(ref.path, finalName);
    }
    return resolvedPathToName.get(ref.path);
  }

  // Renderer-side crop identities (see renderer.js's refIdentity) are
  // 'existing:<name>' or 'external:<sourcePath>' -- the renderer can't
  // know an external image's *final* filename in destDir until it's
  // actually been copied (uniqueFilename() may rename it on collision),
  // so crops are staged against the same identity the image
  // assignment itself was staged against, and resolved here using the
  // very same resolvedPathToName map _resolveImages/_resolveSingleImageRef
  // just populated -- one lookup, same source of truth, so a crop can
  // never end up filed under a different name than the image it's
  // for actually landed at.
  //
  // A crop whose external image was never actually assigned to any
  // target this save (so resolvedPathToName has no entry for its
  // source path) is silently dropped -- there's nothing in destDir
  // for it to apply to, same as an unassigned pool image never being
  // written into metadata.json at all.
  _resolveImageCrops(imageCrops, resolvedPathToName) {
    if (!imageCrops) return undefined;
    const result = {};
    for (const [identityKey, modes] of Object.entries(imageCrops)) {
      let filename = null;
      if (identityKey.startsWith('existing:')) {
        filename = identityKey.slice('existing:'.length);
      } else if (identityKey.startsWith('external:')) {
        filename = resolvedPathToName.get(identityKey.slice('external:'.length)) || null;
      }
      if (filename) result[filename] = modes;
    }
    return Object.keys(result).length > 0 ? result : undefined;
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

  // newPrintFiles is an array of { path (source), images (ImageRef[]),
  // displayName } descriptors -- one per file picked/dropped via the
  // edit-mode "Add print file(s)" flow (itemModal.js's draft.printFiles
  // isNew entries, plus the older lightweight .3mf staging which just
  // has empty images/null displayName, since a .3mf is a companion
  // file with no card of its own to carry an image/name on). Copies
  // each one into destDir (rejecting, before copying anything, a file
  // with an unexpected extension or over MAX_FILE_BYTES -- same
  // "check before touching disk" shape as findOversizedFiles/addItem's
  // pre-flight check above), resolving any filename collision the same
  // way every other collision-prone copy in the app does.
  //
  // Unlike an existing print file, whose caller already knows its real
  // on-disk name to key printFileImages/printFileNames by, a brand new
  // file's renderer-side identity (its original filename, or the
  // gcode-parsed isNew card's sourcePath) isn't necessarily what it
  // ends up named here -- uniqueFilename() can still rename it on a
  // collision. So rather than have the caller guess the right key,
  // this resolves each new file's own images/displayName itself (via
  // the same _resolveSingleImageRef the pre-existing-file path uses,
  // sharing the same resolvedPathToName map so a pool image reused
  // across both is only ever copied once) and returns a
  // { [finalName]: { images?, displayName? } } map already shaped for
  // writeItemMetadata's printFiles field -- the caller just merges it
  // in alongside whatever _resolveImages/_mergePrintFileNames produced
  // for pre-existing files.
  async _resolveNewPrintFiles(destDir, newPrintFiles, resolvedPathToName) {
    const result = {};
    if (!newPrintFiles || newPrintFiles.length === 0) return result;

    for (const entry of newPrintFiles) {
      const sourcePath = entry.path;
      const baseName = path.basename(sourcePath);
      const ext = path.extname(baseName).toLowerCase();
      if (!PRINTFILE_ADD_EXT.has(ext)) {
        throw new Error(`"${baseName}" isn't a print file (.gcode/.bgcode/.3mf).`);
      }
      const stat = await fsp.stat(sourcePath);
      if (stat.size >= MAX_FILE_BYTES) {
        throw new Error(oversizedFilesMessage([{ relPath: baseName, size: stat.size }], MAX_FILE_BYTES));
      }
      const finalName = await uniqueFilename(baseName, (candidate) =>
        pathExists(path.join(destDir, candidate))
      );
      await fsp.copyFile(sourcePath, path.join(destDir, finalName));

      const fields = {};
      if (entry.images && entry.images.length > 0) {
        const names = [];
        for (const ref of entry.images) {
          names.push(await this._resolveSingleImageRef(destDir, ref, resolvedPathToName));
        }
        fields.images = names;
      }
      if (entry.displayName) fields.displayName = entry.displayName;
      // A brand new file is, by definition, being added right now --
      // stamped unconditionally (not folded into the `if
      // Object.keys(fields).length > 0` guard above/below it) so a
      // new file with no image/name override yet still gets a real
      // addedAt instead of showing as "unknown" until the next
      // catalog-wide backfill run.
      fields.addedAt = new Date().toISOString();
      result[finalName] = fields;
    }
    return result;
  }

  // trashedPrintFiles is a plain array of on-disk filenames (pf.key in
  // itemModal.js's draft.printFiles) -- toggled by the trash/restore
  // button on each print-file card, staged client-side the same
  // delete/undo-before-save way the main grid's whole-item trashing
  // already works (see this.changes/deleteItem above), just scoped to
  // one item's own files. This only removes the files themselves --
  // the matching metadata.json cleanup (dropping any stale per-file
  // displayName/images override) is handled separately by
  // writeItemMetadata's removePrintFiles param below, since
  // metadata.json's printFiles map merges rather than replaces and
  // would otherwise keep a deleted file's override forever. Missing
  // files are silently ignored (not an error) since nothing about a
  // plain deletion needs the file to still exist for the outcome
  // ("this filename is gone from the folder") to already be true.
  async _deleteTrashedPrintFiles(dirPath, trashedPrintFiles) {
    if (!trashedPrintFiles || trashedPrintFiles.length === 0) return;
    for (const name of trashedPrintFiles) {
      const filePath = path.join(dirPath, path.basename(name));
      if (await pathExists(filePath)) await fsp.unlink(filePath);
    }
  }

  // Every print file present in a brand new item's folder is, by
  // definition, being added to the catalog right now -- whether it
  // came from the picked source folder itself (never touches
  // _resolveNewPrintFiles, so never gets stamped there) or was added
  // via "+ Add print file(s)" during the same add-mode session
  // (already stamped by _resolveNewPrintFiles above). This walks
  // destDir's actual print files after everything's been copied and
  // fills in addedAt for any that don't already have one from the
  // latter path, so every file in a new item ends up with a real
  // added date rather than "unknown" until the next catalog-wide
  // backfill. Only ever fills in the gap (never overwrites an
  // addedAt _resolveNewPrintFiles already set), and only used by
  // addItem -- editItem's pre-existing files intentionally keep
  // whatever addedAt they already have (see _resolveNewPrintFiles's
  // comment above).
  async _stampInitialAddedAt(destDir, printFiles) {
    let entries;
    try {
      entries = await fsp.readdir(destDir, { withFileTypes: true });
    } catch (err) {
      return printFiles; // shouldn't happen right after copying into it, but don't crash the add over it
    }
    const now = new Date().toISOString();
    const stamped = { ...printFiles };
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!PRINTFILE_ADD_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      if (stamped[entry.name] && stamped[entry.name].addedAt) continue;
      stamped[entry.name] = { ...(stamped[entry.name] || {}), addedAt: now };
    }
    return stamped;
  }

  async addItem(sourceDir, { name, tags, printFileImages, printFileNames, origin, itemImage, imageCrops, newPrintFiles, trashedPrintFiles }) {
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

    // Checked against sourceDir (not destDir) so this rejects before
    // anything is copied into DATA_DIR at all -- see MAX_FILE_BYTES
    // comment above for why this has to happen before the folder ever
    // touches git's working tree.
    const oversized = await findOversizedFiles(sourceDir, MAX_FILE_BYTES);
    if (oversized.length > 0) {
      throw new Error(oversizedFilesMessage(oversized, MAX_FILE_BYTES));
    }

    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.cp(sourceDir, destDir, { recursive: true });
    const resolvedPathToName = new Map(); // external path -> final filename, shared below
    const newPrintFilesResolved = await this._resolveNewPrintFiles(destDir, newPrintFiles, resolvedPathToName);
    await this._deleteTrashedPrintFiles(destDir, trashedPrintFiles);
    const resolvedPrintFiles = await this._stampInitialAddedAt(destDir, {
      ...this._mergePrintFileNames(
        await this._resolveImages(destDir, printFileImages, resolvedPathToName),
        printFileNames
      ),
      ...newPrintFilesResolved,
    });
    const resolvedItemImage = itemImage
      ? await this._resolveSingleImageRef(destDir, itemImage, resolvedPathToName)
      : '';
    const writtenMetadata = await writeItemMetadata(destDir, {
      displayName: name,
      tags,
      printFiles: resolvedPrintFiles,
      origin,
      itemImage: resolvedItemImage,
      imageCrops: this._resolveImageCrops(imageCrops, resolvedPathToName),
      removePrintFiles: trashedPrintFiles,
    });

    // New items get today's protocol applied immediately: if origin is
    // already verified at add time, there's no "existing item" to leave
    // alone -- see pruneToEssentialFiles above.
    if (hasVerifiedOrigin(writtenMetadata)) {
      await pruneToEssentialFiles(destDir);
    }

    this.changes[destDir] = { type: 'add', name };
    return this.changes;
  }

  async editItem(itemPath, { name, tags, printFileImages, printFileNames, origin, itemImage, imageCrops, newPrintFiles, trashedPrintFiles }) {
    // No category anymore, so nothing ever needs to move the item's
    // folder on an edit -- itemPath stays itemPath, only its
    // metadata.json changes.

    // Checked here too (not just in addItem) since an existing item's
    // folder can pick up a new oversized file outside this editor
    // entirely -- e.g. a co-admin dropping an updated print file
    // straight into the folder on disk before opening the editor to
    // reassign its image. Catching it here, before any metadata write,
    // keeps it from ever reaching git add/commit.
    const oversized = await findOversizedFiles(itemPath, MAX_FILE_BYTES);
    if (oversized.length > 0) {
      throw new Error(oversizedFilesMessage(oversized, MAX_FILE_BYTES));
    }

    // Resolved here (not left to guessed filenames) since a new
    // file's images/displayName can only be attached to whatever name
    // it actually ends up on disk under -- see _resolveNewPrintFiles.
    // Nothing downstream depends on that happening before the deletion
    // below, but a co-admin who also assigns an image to the new file
    // in the same save reasonably expects it to already be on disk
    // (and thus a valid print-file card after the next scan) by the
    // time that happens.
    const resolvedPathToName = new Map(); // external path -> final filename, shared below
    const newPrintFilesResolved = await this._resolveNewPrintFiles(itemPath, newPrintFiles, resolvedPathToName);
    await this._deleteTrashedPrintFiles(itemPath, trashedPrintFiles);

    const resolvedPrintFiles = {
      ...this._mergePrintFileNames(
        await this._resolveImages(itemPath, printFileImages, resolvedPathToName),
        printFileNames
      ),
      ...newPrintFilesResolved,
    };
    const resolvedItemImage = itemImage
      ? await this._resolveSingleImageRef(itemPath, itemImage, resolvedPathToName)
      : '';
    const writtenMetadata = await writeItemMetadata(itemPath, {
      displayName: name,
      tags,
      printFiles: resolvedPrintFiles,
      origin,
      itemImage: resolvedItemImage,
      imageCrops: this._resolveImageCrops(imageCrops, resolvedPathToName),
      removePrintFiles: trashedPrintFiles,
    });

    // Pre-existing items only get pruned the next time they're
    // touched through this editor -- that's the rollout window for
    // today's protocol change, so an item nobody's opened yet keeps
    // its full original folder for now regardless of whether it
    // already has a verified origin on file.
    if (hasVerifiedOrigin(writtenMetadata)) {
      await pruneToEssentialFiles(itemPath);
    }

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

    // Entries sharing a `bulk` marker (see backfillAddedDates above)
    // collapse into one "type: N items" line each; everything else
    // still gets its own "type: name" line as before.
    const bulkCounts = {};
    const individualLines = [];
    for (const change of Object.values(this.changes)) {
      if (change.bulk) {
        bulkCounts[change.bulk] = (bulkCounts[change.bulk] || 0) + 1;
      } else {
        individualLines.push(`${change.type}: ${change.name}`);
      }
    }
    const bulkLines = Object.entries(bulkCounts).map(
      ([bulk, count]) => `${bulk}: ${count} item${count === 1 ? '' : 's'}`
    );
    const summaryLines = [...individualLines, ...bulkLines];
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
