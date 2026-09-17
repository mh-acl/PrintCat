'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pushNewItem } = require('./gitPush');
const { APP_VERSION } = require('./version');

// This app's own source repo -- distinct from settings.gitRepoUrl,
// which is the admin-configurable *data* repo each laptop syncs.
// Hardcoded because there's only ever one PrintCat source repo and
// nothing about that identity is meant to vary per laptop.
const RELEASE_OWNER = 'mh-acl';
const RELEASE_REPO = 'PrintCat';

const POINTER_FILENAME = 'catalog-release.json';

// Matches the filename release.sh uploads (a stable rename of
// electron-builder's own zip output, done specifically so this URL
// never has to be looked up -- see release.sh's comments). If that
// naming convention ever changes, it has to change in both places.
function buildReleaseUrl(version) {
  return `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases/download/v${version}/PrintCat-v${version}.zip`;
}

// Checks the data repo's root release pointer against this app's own
// compiled-in version (baked in at build time -- see version.js) and,
// if this app is newer, bumps the pointer and pushes it immediately --
// deliberately independent of whatever the co-admin does next in the
// edit session that's about to open. If it instead just staged the
// change into dataDir and let it ride along with the session's own
// commit, a co-admin who opens edit mode and immediately hits Cancel
// would silently wipe it (editSession.js's cancel does `git checkout
// -- .` / `git clean -fd` over the whole working tree).
//
// Never downgrades: if the pointer already names a version >= this
// app's own, there's nothing to do. That covers both "already
// current" and "this particular laptop hasn't been updated yet" --
// the latter case matters because bumping the pointer down would tell
// every other laptop to fetch a build that's actually a rollback for
// them.
//
// Best-effort and never throws: a parse error, a push rejected by
// another laptop doing this same check around the same time, or a
// network blip are all swallowed. This is bookkeeping, not
// something that should ever block a co-admin from entering edit
// mode -- a missed update here just gets caught the next time anyone
// enters edit mode on a laptop that's already current.
async function checkAndUpdateReleasePointer(dataDir, token, repoUrl, branch) {
  try {
    const pointerPath = path.join(dataDir, POINTER_FILENAME);

    let current = null;
    try {
      current = JSON.parse(await fsp.readFile(pointerPath, 'utf8'));
    } catch (err) {
      current = null; // missing or unparseable -- treated as "no pointer yet"
    }

    if (current && typeof current.version === 'number' && current.version >= APP_VERSION) {
      return;
    }

    const next = { version: APP_VERSION, releaseUrl: buildReleaseUrl(APP_VERSION) };
    await fsp.writeFile(pointerPath, JSON.stringify(next, null, 2) + '\n');

    await pushNewItem({
      targetDir: dataDir,
      repoUrl,
      branch: branch || 'main',
      token,
      commitMessage: `Update release pointer to v${APP_VERSION}`,
    });
  } catch (err) {
    console.error('checkAndUpdateReleasePointer failed (non-fatal):', err);
  }
}

module.exports = { checkAndUpdateReleasePointer, buildReleaseUrl, POINTER_FILENAME };
