'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app, dialog } = require('electron');
const { execFile, spawn } = require('child_process');
const { APP_VERSION } = require('./version');
const { POINTER_FILENAME } = require('./releasePointer');

// Max time with *no* bytes arriving (counted from the request itself,
// then reset on every chunk) before the download is aborted as stalled.
// Deliberately an idle timeout rather than a total-time cap: these are
// ~100MB+ Electron builds that legitimately take minutes on slow wifi,
// but the progress modal (see sendUpdateProgress below) has no dismiss
// button, so a connection that just goes quiet has to fail into the
// normal error dialog instead of leaving a frozen bar on screen forever.
const DOWNLOAD_STALL_TIMEOUT_MS = 60 * 1000;
const UNZIP_TIMEOUT_MS = 60 * 1000;
// Progress events are throttled -- a fast download produces thousands
// of small chunks, and there's no point sending the renderer more than
// a handful of repaints a second.
const PROGRESS_THROTTLE_MS = 100;
// How long the final "closing to finish installing" message stays on
// screen before app.quit(), so it can actually be read rather than
// flashing by as the window disappears.
const FINAL_MESSAGE_HOLD_MS = 1500;
const RM_MAX_RETRIES = 5;
const RM_RETRY_DELAY_MS = 200;

// "Later" just means "not this session" -- there's no persisted
// dismissal, so restarting the app (or the next natural sync tick
// after a relaunch) offers it again. Deliberately not offering a
// permanent "skip this version" option: with four co-admins and an
// app that's meant to stay current across all the loaner laptops,
// re-asking is the safer default.
let dismissedVersion = null;
let checkInProgress = false;

// Pushes a progress update to the main window's update modal (see
// dialogs.js's handleUpdateProgress()). `stage` is one of:
//   'downloading' -- also carries receivedBytes and totalBytes
//                    (totalBytes is null when the server didn't say)
//   'unzipping'
//   'finishing'   -- the install script is spawned and the app is about
//                    to quit; the admin-auth prompt comes next
//   'closed'      -- dismiss the modal (failure path -- the native error
//                    dialog is about to take over)
// Safe to call with a missing/destroyed window (the update just
// proceeds without visible feedback rather than throwing).
function sendUpdateProgress(win, payload) {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isDestroyed()) return;
  win.webContents.send('update:progress', payload);
}

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
// Streams the response body to disk chunk by chunk (each write awaited
// before the next read, so backpressure comes for free) rather than
// buffering ~100-200MB in memory -- reading it chunk by chunk is what
// makes byte-level progress reporting possible in the first place.
// `onProgress({ receivedBytes, totalBytes })` is called (throttled) as
// data arrives, plus once at the end; totalBytes is null when the
// server sent no usable Content-Length. A failed or aborted download
// removes its partial file before throwing.
async function downloadZip(releaseUrl, version, onProgress) {
  const zipPath = path.join(app.getPath('temp'), `printcat-update-v${version}.zip`);
  const controller = new AbortController();
  let stalled = false;
  let stallTimer = null;
  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, DOWNLOAD_STALL_TIMEOUT_MS);
  };

  let fileHandle = null;
  try {
    armStallTimer(); // covers connecting + waiting for response headers
    const response = await fetch(releaseUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status} for ${releaseUrl}`);
    }
    if (!response.body) {
      throw new Error(`Download failed: empty response body for ${releaseUrl}`);
    }

    // Content-Length is only a trustworthy byte total when the body
    // isn't content-encoded (fetch hands back *decoded* bytes, so a
    // gzip'd response's header length wouldn't match what we count).
    // GitHub serves release assets as-is, but don't rely on it.
    const encoding = response.headers.get('content-encoding');
    const declared = Number(response.headers.get('content-length'));
    const totalBytes =
      (!encoding || encoding === 'identity') && Number.isFinite(declared) && declared > 0
        ? declared
        : null;

    fileHandle = await fsp.open(zipPath, 'w');
    const reader = response.body.getReader();
    let receivedBytes = 0;
    let lastReportAt = 0;
    onProgress({ receivedBytes, totalBytes });

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armStallTimer();
      await fileHandle.writeFile(value);
      receivedBytes += value.length;
      const now = Date.now();
      if (now - lastReportAt >= PROGRESS_THROTTLE_MS) {
        lastReportAt = now;
        onProgress({ receivedBytes, totalBytes });
      }
    }

    if (totalBytes !== null && receivedBytes !== totalBytes) {
      throw new Error(`Download incomplete: got ${receivedBytes} of ${totalBytes} bytes`);
    }
    onProgress({ receivedBytes, totalBytes });
  } catch (err) {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
      fileHandle = null;
    }
    await fsp.unlink(zipPath).catch(() => {}); // don't leave a partial zip behind
    if (stalled) {
      throw new Error(
        `Download stalled: no data received for ${DOWNLOAD_STALL_TIMEOUT_MS / 1000} seconds`,
      );
    }
    // fetch's own failures are terse ("fetch failed", "terminated") with
    // the useful part -- DNS failure, connection reset -- on `cause`.
    if (err && err.cause && err.cause.message) {
      throw new Error(`Download failed: ${err.message} (${err.cause.message})`);
    }
    throw err;
  } finally {
    clearTimeout(stallTimer);
    if (fileHandle) await fileHandle.close().catch(() => {});
  }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Deliberately the real `rm -rf` (shelled out, same as unzip below)
// rather than Node's fs.rm -- fs.rm only offers automatic ENOTEMPTY
// retries via its maxRetries/retryDelay options, and those force it
// onto an older internal fallback implementation (distinct from the
// fast path used without them) that has known trouble with symlinks --
// which a .app bundle is full of (e.g. Contents/Frameworks/*.framework
// internals). In practice that fallback didn't just fail on this
// staging dir, it hung: the returned promise never settled either way,
// so nothing ever reached this function's caller's try/catch --
// "failing silently" wasn't a caught-and-swallowed error, it was an
// await that never returned. Shelling out avoids that implementation
// entirely; the retry loop here is our own, for the same underlying
// transient-lock scenario (see stageUpdate below) but without relying
// on fs.rm's retry path to provide it.
async function removeDirWithRetry(dirPath, maxRetries, retryDelayMs) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await runCommand('rm', ['-rf', dirPath], UNZIP_TIMEOUT_MS);
    try {
      await fsp.access(dirPath);
    } catch (err) {
      return; // access() throwing means it's gone -- success
    }
    // Still there -- rm exited 0 but something got recreated mid-delete
    // (the same Spotlight/Gatekeeper-scan race fs.rm's retries were
    // meant to cover). Wait and try the whole rm -rf again.
    if (attempt < maxRetries) await sleep(retryDelayMs);
  }
  throw new Error(`Could not remove ${dirPath} after ${maxRetries + 1} attempt(s)`);
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
  await removeDirWithRetry(stagingDir, RM_MAX_RETRIES, RM_RETRY_DELAY_MS);
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
// so it's handed off to a detached shell script that waits for this
// process's PID to actually exit, then does the swap.
//
// Goes straight to the elevated `osascript ... with administrator
// privileges` attempt rather than trying a plain rm+mv first and only
// elevating on failure. That two-step version had a real failure
// mode: `rm -rf` as a plain (non-admin) user could partially succeed
// -- deleting the bundle's contents while failing to remove the
// bundle directory itself, e.g. on a permissions error partway
// through -- and only *then* hit the elevation fallback; if the
// admin-auth dialog was cancelled at that point, the app was left
// gutted with no way to recover. Going straight to the elevated
// attempt means the entire rm+mv runs as a single privileged
// `do shell script` (the same underlying mechanism sudo-prompt wraps
// elsewhere in this app -- used directly here instead since
// sudo-prompt needs a live Node process, and by this point the app
// has already quit): if the person cancels the auth prompt, nothing
// has been deleted yet, so `set -e` below just stops the script with
// the old app fully intact. The cost is an auth prompt on every
// install, even on laptops where the account could've written to
// /Applications without it -- worth it to make cancellation safe.
// A non-destructive rename-based swap (move the old bundle aside
// first, only remove it after the new one is confirmed in place)
// would remove the need for this tradeoff entirely; noted as a
// follow-up, not done here.
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

${osaLine}

open ${shQuote(oldAppPath)}

rm -rf ${shQuote(stagingDir)}
rm -f ${shQuote(zipPath)}
rm -f "$0"
`;
}

// `onFinishing`, if given, is called once the install script is
// spawned and the app is about to quit, so the caller can put its last
// status message on screen. That message is then held for
// FINAL_MESSAGE_HOLD_MS before app.quit() -- the spawned script just
// polls for this PID to exit (up to ~30s), so the pause costs nothing
// -- and the modal stays up until the process actually exits and the
// script's admin-auth prompt takes over.
async function installAndRelaunch({ newAppPath, stagingDir, zipPath, onFinishing }) {
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
  if (onFinishing) onFinishing();
  await sleep(FINAL_MESSAGE_HOLD_MS);
  app.quit();
}

// Ties the pieces above to the UI: offers the update, and if accepted,
// runs download -> stage -> install, quitting the app at the end.
// While that runs, the main window shows a progress modal (driven by
// the 'update:progress' pushes below -- see dialogs.js's
// handleUpdateProgress()) that stays up until the app quits.
// Never throws -- a download/unzip failure just closes that modal,
// shows an error dialog, and leaves the app running on its current
// version; the next successful catalog sync will offer it again (see
// runCatalogSync() in main.js, the sole caller of this function).
async function checkForUpdateAndPrompt(dataDir, mainWindow) {
  if (checkInProgress) return; // a dialog from a previous sync tick may still be open
  const candidate = await checkForUpdate(dataDir);
  if (!candidate) return;
  if (candidate.version === dismissedVersion) return;

  checkInProgress = true;
  const report = (stage, extra = {}) =>
    sendUpdateProgress(mainWindow, { stage, version: candidate.version, ...extra });
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

    report('downloading', { receivedBytes: 0, totalBytes: null });
    const zipPath = await downloadZip(candidate.releaseUrl, candidate.version, (progress) =>
      report('downloading', progress),
    );
    report('unzipping');
    const { appPath, stagingDir } = await stageUpdate(zipPath, candidate.version);
    await installAndRelaunch({
      newAppPath: appPath,
      stagingDir,
      zipPath,
      onFinishing: () => report('finishing'),
    });
    // installAndRelaunch calls app.quit() on success -- nothing after
    // this point runs.
  } catch (err) {
    report('closed'); // take the progress modal down before the error dialog shows
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
