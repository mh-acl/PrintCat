'use strict';

const path = require('path');
const fsp = require('fs').promises;
const util = require('util');

// sudo-prompt hasn't been updated since 2021 and still calls the
// long-deprecated util.isObject/isFunction/isString helpers -- which
// have since been fully removed from the Node version this Electron
// release bundles, so calling sudo.exec() throws "util.isObject is
// not a function" immediately. There's a maintained fork
// (@vscode/sudo-prompt) meant to fix exactly this, but its latest
// published release doesn't reliably include the fix either (it's
// stuck behind an unmerged/unreleased upstream change), so rather than
// add a second dependency with the same problem, patch the missing
// functions back onto the shared `util` module object here. This MUST
// run before `require('sudo-prompt')` below -- sudo-prompt captures
// these at its own module-load time, so patching afterward would be
// too late even though `util` is otherwise a shared singleton.
if (typeof util.isObject !== 'function') {
  util.isObject = (arg) => arg !== null && typeof arg === 'object';
}
if (typeof util.isFunction !== 'function') {
  util.isFunction = (arg) => typeof arg === 'function';
}
if (typeof util.isString !== 'function') {
  util.isString = (arg) => typeof arg === 'string';
}

const sudo = require('sudo-prompt'); // npm install sudo-prompt

// Root-owned file holding the GitHub push credential (a fine-grained
// Personal Access Token scoped to just this one repo). Provisioned
// once per laptop -- either via scripts/provision-sync-token.sh, or,
// now, inline the first time a push is attempted on a laptop that
// hasn't been set up yet (see writeSyncToken() and
// provisionTokenWindow.js) -- with permissions 600, so a co-admin's
// ordinary (non-admin) session has no path to its contents except by
// successfully completing the native macOS admin-auth prompt in
// readSyncToken() below. There is deliberately no other way to read
// it from inside this app.
const TOKEN_PATH = '/Library/Application Support/PrintCatalog/sync-token';

// Cheap, unprivileged existence check -- distinguishes "this laptop
// hasn't been provisioned yet" from "it has, but the admin prompt
// failed/was cancelled," without needing to invoke sudo-prompt just to
// find out. Works even though the file itself is root-owned and not
// world-readable: checking whether a path exists only requires
// search/execute permission on its parent directories, not read
// permission on the file, so an ordinary session can call this
// without ever being able to see the file's contents.
async function tokenExists() {
  try {
    await fsp.stat(TOKEN_PATH);
    return true;
  } catch (err) {
    return false;
  }
}

// Reads the sync token via a one-off privileged shell command. Uses
// sudo-prompt specifically because it's what pops the native GUI
// authentication dialog (AppleScript's "do shell script ... with
// administrator privileges" under the hood) -- there's no terminal
// here for an interactive `sudo` to prompt into. Resolves with the
// trimmed token string; rejects if the admin cancels the prompt,
// enters the wrong password, or the file doesn't exist. Callers
// should treat all of these alike ("sync can't proceed right now")
// rather than trying to distinguish the reason for the co-admin --
// none of it is something they can act on anyway.
function readSyncToken() {
  return new Promise((resolve, reject) => {
    sudo.exec(`cat "${TOKEN_PATH}"`, { name: 'Print Catalog' }, (error, stdout) => {
      if (error) {
        reject(new Error('Admin authorization was cancelled or failed.'));
        return;
      }
      const token = stdout.toString().trim();
      if (!token) {
        reject(new Error(`No sync token found at "${TOKEN_PATH}".`));
        return;
      }
      resolve(token);
    });
  });
}

// Writes the sync token to TOKEN_PATH as a root-owned, mode-600 file,
// via a single privileged shell command -- one admin-auth prompt
// covers creating the directory, writing the file, and locking down
// its ownership/permissions, rather than three separate prompts. The
// token is base64-encoded before being embedded in the shell command
// and decoded on the other side, so an unusual token value (unlikely
// for a GitHub PAT, but not worth assuming) can't break the command's
// quoting.
//
// This is the in-app equivalent of running
// scripts/provision-sync-token.sh by hand -- called from
// runAddItemsToCatalog() in main.js the first time a push is attempted
// on a laptop where tokenExists() comes back false, so a co-admin
// never needs to touch a terminal. The script still exists too, for
// scripting a batch setup across many laptops at once without opening
// the app on each one.
function writeSyncToken(token) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(token, 'utf8').toString('base64');
    const dir = path.dirname(TOKEN_PATH);
    const cmd = [
      `mkdir -p "${dir}"`,
      `echo "${encoded}" | base64 -d > "${TOKEN_PATH}"`,
      `chown root:wheel "${TOKEN_PATH}"`,
      `chmod 600 "${TOKEN_PATH}"`,
    ].join(' && ');

    sudo.exec(cmd, { name: 'Print Catalog' }, (error) => {
      if (error) {
        reject(new Error('Admin authorization was cancelled or failed.'));
        return;
      }
      resolve();
    });
  });
}

module.exports = { readSyncToken, writeSyncToken, tokenExists, TOKEN_PATH };
