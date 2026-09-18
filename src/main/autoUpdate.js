'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app, dialog } = require('electron');
const { execFile, spawn } = require('child_process');
const { APP_VERSION } = require('./version');
const { POINTER_FILENAME } = require('./releasePointer');

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // generous -- these are ~100MB+ Electron builds
const UNZIP_TIMEOUT_MS = 60 * 1000;

// "Later" just means "not this session" -- there's no persisted
// dismissal, so restarting the app (or the next natural sync tick
// after a relaunch) offers it again. Deliberately not offering a
// permanent "skip this version" option: with four co-admins and an
// app that's meant to stay current across all the loaner laptops,
// re-asking is the safer default.
let dismissedVersion = null;
let checkInProgress = false;

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
function appleScriptEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Reads catalog-release.json out of the already-synced data dir (no
// network call of its own -- gitSync.js's normal sync is what keeps
// this file current) and compares its version against this app's own
// compiled-in APP_VERSION (version.js). Returns the pointer object if
// this app is behind, otherwise null. Skips entirely for unpackaged
// dev builds, where there's no real .app bundle to replace and
// APP_VERSION is just whatever version.js happens to hold.
async function checkForUpdate(dataDir) {
  if (!app.isPackaged) return null;

  let pointer;
  try {
    pointer = JSON.parse(await fsp.readFile(path.join(dataDir, POINTER_FILENAME), 'utf8'));
  } catch (err) {
    return null; // missing/unparseable -- nothing to offer
  }

  if (!pointer || typeof pointer.version !== 'number' || !pointer.releaseUrl) return null;
  if (pointer.version <= APP_VERSION) return null;
  return pointer;
}

// Downloads the release zip into a fixed-per-version temp path
// (overwritten if a previous attempt left one behind, so a retry
// after a failed install doesn't need its own cleanup step first).
// Buffers the whole response in memory before writing -- simpler than
// piping a web ReadableStream to a Node fs stream, and fine for a
// one-off ~100-200MB download that only happens right before a quit.
async function downloadZip(releaseUrl, version) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(releaseUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} for ${releaseUrl}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());

  const zipPath = path.join(app.getPath('temp'), `printcat-update-v${version}.zip`);
  await fsp.writeFile(zipPath, buf);
  return zipPath;
}

function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

// Unzips into a fixed-per-version staging dir (cleared first, same
// retry-friendliness reasoning as downloadZip) and locates the
// resulting .app bundle -- electron-builder's mac zip target zips the
// bundle directly at the archive's top level, so this expects exactly
// one *.app entry there. Throws with a clear message if that shape
// ever changes (e.g. an electron-builder config change nests it
// differently), rather than silently proceeding with a wrong path.
async function stageUpdate(zipPath, version) {
  const stagingDir = path.join(app.getPath('temp'), `printcat-update-staging-v${version}`);
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await fsp.mkdir(stagingDir, { recursive: true });

  await runCommand('unzip', ['-oq', zipPath, '-d', stagingDir], UNZIP_TIMEOUT_MS);

  const entries = await fsp.readdir(stagingDir);
  const appEntry = entries.find((e) => e.endsWith('.app'));
  if (!appEntry) {
    throw new Error(`No .app bundle found in unzipped release (staging dir: ${stagingDir})`);
  }
  return { appPath: path.join(stagingDir, appEntry), stagingDir };
}

// Walks up from the running Electron binary to its .app bundle root:
// <bundle>.app/Contents/MacOS/<exe> -- three levels.
function getCurrentAppBundlePath() {
  const bundlePath = path.dirname(path.dirname(path.dirname(process.execPath)));
  if (!bundlePath.endsWith('.app')) {
    throw new Error(`Could not resolve a .app bundle from execPath: ${process.execPath}`);
  }
  return bundlePath;
}

// The actual swap can't safely happen while this process is still
// running (see ARCHITECTURE.md's "Not yet implemented" note on this),
// so it's handed off to a detached shell script that: waits for this
// process's PID to actually exit, does a plain rm+mv, and -- only if
// that fails, e.g. the install lives somewhere this account can't
// write to without elevation -- retries the same rm+mv wrapped in
// `osascript ... with administrator privileges`, which pops the native
// macOS admin-auth prompt (the same underlying mechanism sudo-prompt
// wraps elsewhere in this app, used directly here instead since
// sudo-prompt itself needs a live Node process to invoke it, and by
// this point the app has already quit). Then relaunches and cleans up
// after itself, including deleting its own script file.
function buildInstallScript({ oldAppPath, newAppPath, stagingDir, zipPath, pid }) {
  const swapCmd = `rm -rf ${shQuote(oldAppPath)} && mv ${shQuote(newAppPath)} ${shQuote(oldAppPath)}`;
  const osaLine = `osascript -e "do shell script \\"${appleScriptEscape(swapCmd)}\\" with administrator privileges"`;

  return `#!/bin/bash
set -e

# Wait up to ~30s for the old process to actually exit.
for i in $(seq 1 60); do
  if ! kill -0 ${pid} 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if ! (${swapCmd}); then
  ${osaLine}
fi

open ${shQuote(oldAppPath)}

rm -rf ${shQuote(stagingDir)}
rm -f ${shQuote(zipPath)}
rm -f "$0"
`;
}

async function installAndRelaunch({ newAppPath, stagingDir, zipPath }) {
  const oldAppPath = getCurrentAppBundlePath();
  const scriptPath = path.join(app.getPath('temp'), 'printcat-install-update.sh');
  const script = buildInstallScript({
    oldAppPath,
    newAppPath,
    stagingDir,
    zipPath,
    pid: process.pid,
  });
  await fsp.writeFile(scriptPath, script, { mode: 0o755 });

  spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

// Ties the pieces above to the UI: offers the update, and if accepted,
// runs download -> stage -> install, quitting the app at the end.
// Never throws -- a download/unzip failure just shows an error dialog
// and leaves the app running on its current version; the next
// successful catalog sync will offer it again (see runCatalogSync() in
// main.js, the sole caller of this function).
async function checkForUpdateAndPrompt(dataDir, mainWindow) {
  if (checkInProgress) return; // a dialog from a previous sync tick may still be open
  const candidate = await checkForUpdate(dataDir);
  if (!candidate) return;
  if (candidate.version === dismissedVersion) return;

  checkInProgress = true;
  try {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Later', `Install v${candidate.version} and Relaunch`],
      defaultId: 1,
      cancelId: 0,
      title: 'Update available',
      message: `Print Catalog v${candidate.version} is available (you're on v${APP_VERSION}).`,
      detail: 'Installing will close and reopen the app. This can take a minute.',
    });
    if (response !== 1) {
      dismissedVersion = candidate.version;
      return;
    }

    const zipPath = await downloadZip(candidate.releaseUrl, candidate.version);
    const { appPath, stagingDir } = await stageUpdate(zipPath, candidate.version);
    await installAndRelaunch({ newAppPath: appPath, stagingDir, zipPath });
    // installAndRelaunch calls app.quit() on success -- nothing after
    // this point runs.
  } catch (err) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Update failed',
      message: `Couldn't install v${candidate.version}.`,
      detail: `${err.message}\n\nStill running v${APP_VERSION}. This will be offered again on the next sync.`,
    });
  } finally {
    checkInProgress = false;
  }
}

module.exports = { checkForUpdate, checkForUpdateAndPrompt, getCurrentAppBundlePath };
