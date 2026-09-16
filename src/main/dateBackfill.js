'use strict';

// dateBackfill.js
//
// Computes a best-guess "added to catalog" date for an existing item,
// for editSession.js's one-off backfillAddedDates() (see main.js's
// Tools-menu wiring for why this exists at all: items added before
// this feature shipped never had an accurate importedAt recorded --
// see itemMetadata.js).
//
// Two independent signals, and we take whichever is OLDER:
//
// - git history: the earliest commit that ever touched anything under
//   this item's folder in the data repo. Accurate for items added
//   through this app's own git-backed add flow, but the data repo's
//   history only goes back to whenever this git-based workflow itself
//   started -- items that existed since the pre-Electron static-site
//   era only show up as "added" whenever they were migrated into this
//   repo, which is later than when they were actually first added to
//   the catalog.
// - filesystem mtimes: the earliest modification time among the
//   item's own real content files (not metadata.json, which this app
//   rewrites on every edit). These can still carry original
//   download-era timestamps for items whose files were never
//   re-touched since, reaching further back than git history does for
//   exactly the older items above.
//
// Neither signal is trustworthy alone across the whole catalog's
// history, but the older of the two is never a worse answer than
// either alone.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { run } = require('./gitSync');

// gitSync.js's syncCatalogRepo() always clones/fetches with --depth 1,
// so every laptop's normal working copy of the data repo has only the
// single latest commit -- `git log` against it would find nothing
// older than that no matter what. isShallowRepo/unshallowRepo below
// exist so the caller can convert to a full clone once, on demand,
// right before actually walking history. This is a one-time,
// permanent change to that laptop's local checkout (bigger .git, one
// deeper fetch) -- harmless afterward (gitSync.js's own --depth 1
// fetches still work fine against an already-full repo), but a real
// lasting side effect the caller should only take deliberately, not
// as a surprise side effect of an unrelated read.
async function isShallowRepo(dataDir, timeoutMs) {
  try {
    const { stdout } = await run('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: dataDir,
      timeoutMs,
    });
    return stdout.trim() === 'true';
  } catch (err) {
    // Can't tell (not a repo at all, git missing, etc.) -- treat as
    // not shallow; the git-log calls below will just come back empty
    // and this falls back to the filesystem signal alone.
    return false;
  }
}

async function unshallowRepo(dataDir, timeoutMs) {
  await run('git', ['fetch', '--unshallow', 'origin'], { cwd: dataDir, timeoutMs });
}

// Oldest commit date (ISO 8601) that ever touched anything under
// relPath, or null if git has no history for it at all (e.g. an item
// that somehow only exists in the local working tree).
async function computeGitEarliestDate(relPath, dataDir, timeoutMs) {
  try {
    const { stdout } = await run('git', ['log', '--format=%aI', '--', relPath], {
      cwd: dataDir,
      timeoutMs,
    });
    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    return lines[lines.length - 1]; // git log is newest-first; oldest is the last line
  } catch (err) {
    return null;
  }
}

// Oldest mtime (ISO 8601) among the item's own files, recursively --
// covers pre-pruning items that still have subfolders from their
// original zip download. Skips metadata.json (rewritten by this app
// on every save, so its mtime reflects the last edit, not the add
// date) and dotfiles (Finder/OS cruft like .DS_Store, not meaningful
// content). Returns null if the folder has no other files at all.
async function computeFsEarliestDate(itemPath) {
  let earliestMs = null;

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      return; // vanished mid-walk -- nothing to do
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'metadata.json') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(full);
          if (earliestMs === null || stat.mtimeMs < earliestMs) earliestMs = stat.mtimeMs;
        } catch (err) {
          // vanished mid-walk -- skip
        }
      }
    }
  }

  await walk(itemPath);
  return earliestMs === null ? null : new Date(earliestMs).toISOString();
}

// Combines both signals for one item, returning the older of the two
// plus which one won (so the caller can report it). Falls back to
// "now" -- flagged via source -- only when neither signal produced
// anything at all, which shouldn't normally happen for a real item.
async function computeAddedDate(itemPath, dataDir, timeoutMs) {
  const relPath = path.relative(dataDir, itemPath);
  const gitDateStr = await computeGitEarliestDate(relPath, dataDir, timeoutMs);
  const fsDateStr = await computeFsEarliestDate(itemPath);
  const gitMs = gitDateStr ? Date.parse(gitDateStr) : null;
  const fsMs = fsDateStr ? Date.parse(fsDateStr) : null;

  if (gitMs != null && fsMs != null) {
    return gitMs <= fsMs
      ? { date: new Date(gitMs).toISOString(), source: 'git' }
      : { date: new Date(fsMs).toISOString(), source: 'filesystem' };
  }
  if (gitMs != null) return { date: new Date(gitMs).toISOString(), source: 'git' };
  if (fsMs != null) return { date: new Date(fsMs).toISOString(), source: 'filesystem' };
  return { date: new Date().toISOString(), source: 'fallback-now' };
}

module.exports = { isShallowRepo, unshallowRepo, computeAddedDate };
