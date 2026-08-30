'use strict';

const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('path');
const fsp = require('fs').promises;
const chokidar = require('chokidar'); // npm install chokidar

const { Indexer } = require('./indexer');
const { ThumbnailCache } = require('./thumbnailCache');
const { ThumbnailResolver } = require('./thumbnailResolver');
const { listUsbDrives, ejectDrive, isDiskPresent } = require('./drives');
const { SettingsStore } = require('./settings');
const { syncCatalogRepo } = require('./gitSync');
const { SyncStateStore } = require('./syncState');
const { TOOLS } = require('./tools');
const { openUsbWiperWindow } = require('./usbWiperWindow');
const { pushNewItem } = require('./gitPush');
const { readSyncToken, writeSyncToken, tokenExists } = require('./tokenStore');
const { promptForToken } = require('./provisionTokenWindow');
const { EditSession } = require('./editSession');
const { stripTrailingId } = require('./folderName');
const { uniqueFilename } = require('./uniqueFilename');

// The single in-progress editing session, or null when a co-admin
// hasn't entered edit mode. Only one at a time -- see
// enterEditSession() below.
let editSession = null;

// Sets the name shown in the macOS menu bar's application menu (the
// bold item to the left of File/Edit/etc) and used by the `role:
// 'about'` menu item below. This must run before app.whenReady() to
// take effect.
//
// NOTE: this does NOT rename the Dock icon's label while running
// unpackaged (e.g. via `electron .` or `npm start`) -- that text comes
// from Electron's own bundled Info.plist, not from anything the app
// itself can set at runtime. Getting "Print Catalog" in the Dock
// requires packaging the app (electron-builder / Electron Forge) with
// its "productName" set to "Print Catalog", which bakes a real
// Info.plist with that name into the built .app bundle.
app.setName('Print Catalog');

// Git repo URL/branch now live in settings.json (admin-configurable via
// the Settings dialog) rather than env vars, so DATA_DIR can't be
// decided until settingsStore has loaded -- see resolveDataDir() and
// the top of setupIndexer() below. PRINTCAT_DATA_DIR is still an env
// var: it's a dev-time convenience, not something the settings dialog
// exposes.
let DATA_DIR;

function resolveDataDir(settings) {
  if (settings.gitRepoUrl) {
    return path.join(app.getPath('userData'), 'print-catalog-data');
  }
  if (process.env.PRINTCAT_DATA_DIR) {
    return process.env.PRINTCAT_DATA_DIR;
  }
  // Dev-time convenience only: __dirname sits under the real project
  // folder when unpackaged, so ../../data is the repo's data/ dir. In
  // a packaged build __dirname is inside app.asar, which is read-only
  // and not even a real directory on disk -- falling back to that path
  // here caused ENOTDIR on mkdir. Packaged + no git sync + no env
  // override means there's no source of truth for the data, so use a
  // writable per-user location instead.
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'print-catalog-data')
    : path.join(__dirname, '..', '..', 'data');
}

let mainWindow;
let indexer;
let thumbnailCache;
let thumbnailResolver;
let settingsStore;
let syncStateStore;
let syncInProgress = false;

// Runs a Tools-menu task: confirms first (Cancel is both the default
// and the Escape/close action, since every task here is destructive),
// then runs it and reports success/failure. Errors thrown by run()
// (e.g. the guest-account check in tools.js failing) are shown in an
// error dialog rather than crashing the app; a resolved
// { failures: [...] } means the task mostly succeeded but couldn't
// remove everything, which is reported separately from total failure.
async function runTool(task) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', task.label],
    defaultId: 0,
    cancelId: 0,
    title: task.confirmTitle,
    message: task.confirmMessage,
    detail: task.confirmDetail,
  });
  if (response !== 1) return;

  try {
    const result = await task.run();
    const failures = (result && result.failures) || [];
    if (failures.length === 0) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: task.label,
        message: `${task.label} completed successfully.`,
      });
    } else {
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: task.label,
        message: `${task.label} finished, but ${failures.length} item(s) could not be removed.`,
        detail: failures.map((f) => `${f.path}: ${f.error}`).join('\n'),
      });
    }
  } catch (err) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: `${task.label} failed`,
      message: err.message,
    });
  }
}

// Gets the push token, provisioning this laptop inline (see
// tokenStore.js/provisionTokenWindow.js) if it hasn't been set up yet.
// Returns null if the admin cancels either the provisioning dialog or
// the OS auth prompt -- callers treat that as "back out quietly",
// same as any other cancel in this flow.
async function getOrProvisionToken() {
  if (await tokenExists()) return readSyncToken();
  const entered = await promptForToken(mainWindow);
  if (!entered) return null;
  await writeSyncToken(entered);
  return entered;
}

// "Edit Print Catalog..." -- lets a co-admin enter a single editing
// session covering any number of adds/edits/deletes (see
// editSession.js), reviewed together and pushed as one commit, rather
// than the old flow's one-folder-in-one-push-out. Just flips the
// renderer into its editing-mode view (see renderer.js) -- everything
// else (folder picking, staging, the confirm/cancel push) happens via
// the editSession:* IPC handlers below, driven from that UI.
function enterEditSession() {
  const settings = settingsStore.get();
  if (!settings.gitRepoUrl) {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Edit Print Catalog',
      message: 'No Git repository is configured yet.',
      detail: 'Set one up in Settings before editing the catalog.',
    });
    return;
  }
  if (!editSession) editSession = new EditSession(DATA_DIR);
  mainWindow.webContents.send('editSession:entered');
  broadcastSyncStatus(); // reflects pausedForEdit right away, not just on the next sync tick
}

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const openSettings = () => {
    if (mainWindow) mainWindow.webContents.send('menu:openSettings');
  };

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings\u2026', accelerator: 'Cmd+,', click: openSettings },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : [
          {
            label: 'File',
            submenu: [{ label: 'Settings\u2026', accelerator: 'Ctrl+,', click: openSettings }, { role: 'quit' }],
          },
        ]),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Tools',
      submenu: [
        ...TOOLS.map((task) => ({
          label: task.label,
          click: () => runTool(task),
        })),
        { type: 'separator' },
        { label: 'USB Wiper', click: () => openUsbWiperWindow(settingsStore) },
        { label: 'Edit Print Catalog\u2026', click: () => enterEditSession() },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // The item detail view's "View original on ..." / creator links (see
  // renderer.js's renderOriginInfo()) use target="_blank" -- without
  // this handler, Electron's default behavior for that is either to
  // silently block the request or pop open a bare, chromeless
  // BrowserWindow rendering the external page *inside the app*,
  // neither of which is "open in the co-admin's actual default
  // browser." Denying the in-app window and handing the URL to
  // shell.openExternal() instead is the standard Electron pattern for
  // this. Applies to any window.open()/target="_blank" request from
  // this app's own renderer, not just the origin links specifically --
  // there's only ever one BrowserWindow in this app, so no need to
  // scope it further.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Defense in depth: if anything ever tried to navigate this window
  // itself to an external page (rather than opening a new one), send
  // that out to the default browser too instead of letting the
  // catalog's own window get hijacked away from index.html.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return; // normal in-app navigation (loadFile, reload)
    event.preventDefault();
    shell.openExternal(url);
  });
}

// Settings must load before DATA_DIR can be resolved, since gitRepoUrl
// (if set) determines which directory the catalog lives in at all --
// and before setupIndexer can even be attempted, since whenReady()
// needs to know gitRepoUrl to decide whether there's anything to
// index yet. Split out from setupIndexer so it can run first.
async function loadSettings() {
  const userDataDir = app.getPath('userData');
  settingsStore = new SettingsStore({
    settingsFile: path.join(userDataDir, 'settings.json'),
  });
  await settingsStore.load();
}

async function setupIndexer() {
  const userDataDir = app.getPath('userData');

  DATA_DIR = resolveDataDir(settingsStore.get());

  // On a brand new install with git sync configured, nothing has been
  // cloned yet -- make sure the folder exists so the first scan finds
  // an empty catalog instead of erroring, and so chokidar has a real
  // path to watch from the start.
  await fsp.mkdir(DATA_DIR, { recursive: true });

  indexer = new Indexer({
    dataDir: DATA_DIR,
    cacheFile: path.join(userDataDir, 'catalog-cache.json'),
  });
  await indexer.loadCache();
  await indexer.scan();

  thumbnailCache = new ThumbnailCache({
    cacheDir: path.join(userDataDir, 'thumb-cache'),
  });
  thumbnailResolver = new ThumbnailResolver({ thumbnailCache });

  syncStateStore = new SyncStateStore({
    stateFile: path.join(userDataDir, 'git-sync-state.json'),
  });
  await syncStateStore.load();

  // Watch the data dir for changes made outside the app (a `git pull`,
  // or someone dropping a new model folder in) and rescan in the
  // background, then push the fresh tree to the renderer.
  //
  // awaitWriteFinish guards against reading a file mid-write -- a git
  // sync can be checking out sizeable binary gcode files (see
  // gitSync.js's DEFAULT_TIMEOUT_MS comment), and without this a
  // rescan can fire the moment a file is first touched rather than
  // once it's actually done being written.
  const watcher = chokidar.watch(DATA_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  let rescanTimer = null;
  const scheduleRescan = () => {
    clearTimeout(rescanTimer);
    // Debounce -- a git pull touches many files in one burst.
    rescanTimer = setTimeout(refreshCatalog, 500);
  };
  watcher.on('add', scheduleRescan);
  watcher.on('change', scheduleRescan);
  watcher.on('unlink', scheduleRescan);
}

// Rescans the data dir and pushes the fresh tree to the renderer.
// Shared by the chokidar watcher above (a `git pull` or other outside
// change), and meant to also back a future manual "refresh" button
// and/or a timed auto-refresh -- all three are just different triggers
// for the same "rescan and broadcast" action.
//
// Deliberately swallows its own errors rather than letting a transient
// failure (e.g. a file disappearing mid-scan because a concurrent
// `git clean -fd` raced the scan, or any other one-off fs hiccup)
// silently drop the update forever -- previously an uncaught exception
// here meant the open window never heard about the change until the
// app was relaunched, since indexer.scan() itself has no internal
// error handling. On failure we log and retry shortly instead, since
// the next attempt will very likely land after whatever was transient
// has settled.
let catalogRefreshRetryTimer = null;
async function refreshCatalog() {
  clearTimeout(catalogRefreshRetryTimer);
  try {
    const tree = await indexer.scan();
    if (mainWindow) mainWindow.webContents.send('catalog:updated', tree);
  } catch (err) {
    console.warn('[indexer] rescan failed, retrying shortly:', err.message);
    catalogRefreshRetryTimer = setTimeout(refreshCatalog, 1000);
  }
}

// Status shown in the renderer's footer ("Last catalog refresh: ...").
// `configured` lets the renderer distinguish "no git sync set up at all"
// from "set up, but hasn't succeeded yet" (both start out with
// lastSuccessAt: null).
function getSyncStatusPayload() {
  return {
    configured: Boolean(settingsStore && settingsStore.get().gitRepoUrl),
    lastSuccessAt: syncStateStore ? syncStateStore.get().lastSuccessAt : null,
    inProgress: syncInProgress,
    // Lets the renderer explain (and grey out the refresh button)
    // rather than have a click silently no-op -- see runCatalogSync()'s
    // editSession guard above.
    pausedForEdit: Boolean(editSession),
  };
}

function broadcastSyncStatus() {
  if (mainWindow) mainWindow.webContents.send('sync:statusChanged', getSyncStatusPayload());
}

// Kicks off the git sync without blocking the caller. The catalog
// keeps showing whatever was already on disk while this runs; if the
// sync changes anything, the chokidar watcher in setupIndexer() picks
// up the file events and pushes a fresh tree to the renderer on its
// own (see refreshCatalog()). In the common case (already up to date)
// this just adds a no-op fetch in the background; only when there's
// actually new data does a rescan happen.
//
// Shared by three triggers: the one-time sync on launch, the manual
// "refresh now" button (ipcMain 'sync:refreshNow' below), and the
// timed auto-refresh (scheduleAutoRefresh() below). Guarded against
// overlapping runs -- if one's already in flight (from any of those
// three triggers), a new call is a no-op rather than running a second
// git command against the same working dir concurrently; the
// in-flight run will pick up the latest data anyway.
//
// Also guarded against an active edit session: editSession.js stages
// every add/edit as uncommitted working-tree state (new untracked
// folders, modified metadata.json files) directly inside DATA_DIR, and
// gitSync.js's `reset --hard` + `clean -fd` would silently discard all
// of it with no warning -- previously nothing stopped the timed
// auto-refresh or the "Refresh Now" button from doing exactly that
// mid-edit. Skipping here is safe: this just means one fewer sync
// tick happens while a co-admin is mid-session, and the timer/button
// will succeed again as soon as editSession goes back to null (the
// session is cancelled or pushed).
function runCatalogSync() {
  if (syncInProgress) return;
  if (editSession) return;

  const { gitRepoUrl, gitBranch } = settingsStore.get();
  if (!gitRepoUrl) return;

  const overrideTimeoutMs = process.env.PRINTCAT_GIT_SYNC_TIMEOUT_MS
    ? Number(process.env.PRINTCAT_GIT_SYNC_TIMEOUT_MS)
    : undefined;

  syncInProgress = true;
  broadcastSyncStatus();

  syncCatalogRepo({
    repoUrl: gitRepoUrl,
    branch: gitBranch || 'main',
    targetDir: DATA_DIR,
    ...(overrideTimeoutMs ? { timeoutMs: overrideTimeoutMs } : {}),
  }).then(async (result) => {
    if (result.synced) {
      await syncStateStore.recordSuccess();
    } else {
      console.warn('[gitSync] sync did not complete:', result.reason, result.error || '');
    }
    syncInProgress = false;
    broadcastSyncStatus();
  });
}

// Timed background refresh, on top of the launch-time sync and the
// manual refresh button. Re-derived from settings (rather than fixed
// at startup) so toggling the checkbox or changing the frequency in
// Settings takes effect immediately -- unlike gitRepoUrl/gitBranch,
// this doesn't touch DATA_DIR or the chokidar watcher, so it never
// needs a restart. Call this once after the initial setup, and again
// every time settings are saved.
let autoRefreshTimer = null;
const AUTO_REFRESH_UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };
function scheduleAutoRefresh() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;

  const { autoRefreshEnabled, autoRefreshValue, autoRefreshUnit } = settingsStore.get();
  if (!autoRefreshEnabled) return;

  const value = Number(autoRefreshValue);
  const unitMs = AUTO_REFRESH_UNIT_MS[autoRefreshUnit] || AUTO_REFRESH_UNIT_MS.hours;
  if (!Number.isFinite(value) || value <= 0) return;

  autoRefreshTimer = setInterval(runCatalogSync, value * unitMs);
}

// Guarded because in required-setup mode (no gitRepoUrl yet, see
// whenReady()) setupIndexer never runs, so `indexer` is undefined --
// renderer.js's init() is written not to call this in that case, but
// this is cheap insurance against it happening anyway.
ipcMain.handle('catalog:getTree', async () => (indexer ? indexer.scan() : []));

ipcMain.handle('catalog:getItemThumbnail', async (event, itemNode) =>
  thumbnailResolver.resolveItemThumbnail(itemNode)
);

ipcMain.handle('catalog:getFileThumbnail', async (event, fileEntry, imageFiles) =>
  thumbnailResolver.resolveFileThumbnail(fileEntry, imageFiles || [])
);

ipcMain.handle('drives:list', async () => listUsbDrives());

ipcMain.handle('drives:saveFile', async (event, sourcePath, mountPoint) => {
  // Basic sanity check -- only ever copy files that actually live
  // inside our own data directory, not an arbitrary path.
  const resolvedSource = path.resolve(sourcePath);
  if (!resolvedSource.startsWith(path.resolve(DATA_DIR) + path.sep)) {
    throw new Error('Refusing to copy a file outside the data directory');
  }

  // These are shared, accumulating USB drives (see drives.js) -- a
  // generic print-file name colliding with something already on the
  // stick is plausible, so pick a non-colliding name (name.1.ext,
  // name.2.ext, ...) instead of silently overwriting whatever's there.
  const desiredName = path.basename(sourcePath);
  const destName = await uniqueFilename(desiredName, async (candidate) => {
    try {
      await fsp.access(path.join(mountPoint, candidate));
      return true;
    } catch (err) {
      return false;
    }
  });

  const destPath = path.join(mountPoint, destName);
  await fsp.copyFile(resolvedSource, destPath);
  return { path: destPath, name: destName };
});

ipcMain.handle('drives:eject', async (event, diskIdentifier) => {
  await ejectDrive(diskIdentifier);
});

ipcMain.handle('drives:isPresent', async (event, diskIdentifier) => isDiskPresent(diskIdentifier));

// Every editSession:* handler below assumes enterEditSession() already
// ran (editSession is non-null) -- the renderer only calls these once
// it's received 'editSession:entered', so this holds in practice; it's
// not re-checked per call.

// Shared by the "Add item" button (after the folder dialog) and a
// folder dropped directly onto the window (see
// editSession:prepareAddFolder below, and renderer.js's document-level
// drop handler) -- both just need "here's a folder path, tell me
// what's in it" without a dialog in the drop case.
async function prepareAddFolder(sourceDir) {
  const stat = await fsp.stat(sourceDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error('That isn\'t a folder -- drop a project folder to add it as an item.');
  }
  const { printFiles, imageFiles, explicitThumb, origin } = await editSession.scanSourceFolder(sourceDir);
  return {
    sourceDir,
    suggestedName: stripTrailingId(path.basename(sourceDir)),
    printFiles,
    imageFiles,
    explicitThumb,
    origin,
  };
}

ipcMain.handle('editSession:pickAddFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a print item folder',
    properties: ['openDirectory'],
  });
  if (canceled || filePaths.length === 0) return null;
  return prepareAddFolder(filePaths[0]);
});

ipcMain.handle('editSession:prepareAddFolder', async (event, sourceDir) => prepareAddFolder(sourceDir));

// Lets the co-admin add images from outside the item's folder (e.g. a
// better photo saved elsewhere) without drag-and-drop. Deliberately
// doesn't copy anything yet -- just returns the picked paths, so
// Cancel on the item editor still means nothing touched disk; the
// actual copy happens in editSession.js's _resolveImages(), as part of
// commitAdd/commitEdit below.
ipcMain.handle('editSession:browseImages', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select images to add',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'svg'] }],
  });
  if (canceled) return [];
  return filePaths.map((p) => ({ path: p, name: path.basename(p) }));
});

// Used by the 'edit' item editor to autofill "Original Location" (and
// creator info, when detectable) when the item's metadata.json doesn't
// already have creator info stored -- including items that already
// have an origin.url but were catalogued before creator extraction
// existed (see originLocation.js/editSession.js) -- 'add' mode gets
// this for free from scanSourceFolder()'s origin above instead, since
// it's already scanning the folder for print files/images at that
// point. Returns the same { url, creatorName, creatorUrl } shape as
// that origin field.
ipcMain.handle('editSession:detectOrigin', async (event, itemPath) => editSession.detectOrigin(itemPath));

// One-shot catch-up for every item already in the catalog that's
// missing creator info -- see editSession.js's backfillOrigins() for
// the per-item skip rules (mismatched/not-found items are left
// untouched, not force-updated). Requires an active edit session, same
// as every other mutating editSession:* handler here -- the renderer
// only exposes the button that calls this while editModeActive, so
// editSession is never null in practice, but the check keeps a stray
// call from throwing a confusing "cannot read property of null"
// instead of a clear message.
ipcMain.handle('editSession:backfillOrigins', async () => {
  if (!editSession) throw new Error('Start an edit session before backfilling.');
  const items = await indexer.scan();
  const result = await editSession.backfillOrigins(items);
  return { result, changes: editSession.getChanges(), tree: await indexer.scan() };
});

ipcMain.handle('editSession:commitAdd', async (event, sourceDir, fields) => {
  const changes = await editSession.addItem(sourceDir, fields);
  return { changes, tree: await indexer.scan() };
});

ipcMain.handle('editSession:commitEdit', async (event, itemPath, fields) => {
  const changes = await editSession.editItem(itemPath, fields);
  return { changes, tree: await indexer.scan() };
});

ipcMain.handle('editSession:deleteItem', async (event, itemPath) => editSession.deleteItem(itemPath));

ipcMain.handle('editSession:undoDelete', async (event, itemPath) => editSession.undoDelete(itemPath));

ipcMain.handle('editSession:cancelSession', async () => {
  await editSession.cancel();
  editSession = null;
  broadcastSyncStatus(); // clears pausedForEdit right away
  return indexer.scan();
});

// Pushes everything staged this session as one commit. On failure, the
// session is left active (nothing is cleared) so the co-admin can
// simply retry -- the underlying deletes/writes already happened
// locally and are idempotent to repeat, same as retrying any other
// gitSync failure. On success, the session ends and the renderer goes
// back to normal browsing.
ipcMain.handle('editSession:confirmSession', async () => {
  const settings = settingsStore.get();
  const { commitMessage } = await editSession.confirm();

  const token = await getOrProvisionToken();
  if (!token) return { ok: false, cancelled: true };

  await pushNewItem({
    targetDir: DATA_DIR,
    repoUrl: settings.gitRepoUrl,
    branch: settings.gitBranch || 'main',
    token,
    commitMessage,
  });

  editSession = null;
  broadcastSyncStatus(); // clears pausedForEdit right away
  return { ok: true, tree: await indexer.scan() };
});

ipcMain.handle('settings:get', async () => settingsStore.get());

// DATA_DIR is resolved once at startup from whatever gitRepoUrl was
// set at the time (see resolveDataDir()). Changing gitRepoUrl or
// gitBranch here doesn't retarget the already-running indexer /
// thumbnail cache / chokidar watcher, so we report back whether a
// restart is needed rather than trying to hot-swap all of that live.
ipcMain.handle('settings:save', async (event, newSettings) => {
  const before = settingsStore.get();
  const saved = await settingsStore.save(newSettings);
  const needsRestart =
    before.gitRepoUrl !== saved.gitRepoUrl || (before.gitBranch || 'main') !== (saved.gitBranch || 'main');
  // Unlike gitRepoUrl/gitBranch, auto-refresh is just a timer -- always
  // safe to re-derive right away, including in required-setup mode
  // (harmless there since the app relaunches immediately afterward
  // anyway; see renderer.js's openSettingsDialog()).
  scheduleAutoRefresh();
  return { settings: saved, needsRestart };
});

// Holds a just-imported sync token between settings:import and
// settings:confirmImportToken below. Deliberately never sent to the
// renderer as part of settings:import's own return value -- the token
// is meant to have no path into the renderer at all (see tokenStore.js),
// so it's stashed here in the main process and only written to
// TOKEN_PATH if the admin explicitly confirms via the renderer's own
// confirm() dialog, exactly mirroring how a push's token read/write
// already never touches renderer memory.
let pendingImportToken = null;

// Writes the current settings (NOT including the sync token, which
// lives outside settingsStore entirely -- see includeToken below) to a
// JSON file the admin picks, for copying to another laptop.
ipcMain.handle('settings:export', async (event, { includeToken } = {}) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Print Catalog Settings',
    defaultPath: 'print-catalog-settings.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, cancelled: true };

  const payload = {
    printCatalogSettingsExport: 1,
    exportedAt: new Date().toISOString(),
    settings: settingsStore.get(),
  };

  if (includeToken) {
    if (!(await tokenExists())) {
      throw new Error('No sync token has been provisioned on this laptop yet -- nothing to export.');
    }
    // Pops the native macOS admin-auth prompt (see tokenStore.js) --
    // if the admin cancels or fails it, readSyncToken() rejects and
    // this whole handler rejects with it, so no partial file gets
    // written without the token the admin asked to include.
    payload.syncToken = await readSyncToken();
  }

  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2));
  return { ok: true, path: filePath, includedToken: Boolean(includeToken) };
});

// Reads settings (and, if present, a sync token) from a previously
// exported file and applies the settings immediately via the same
// path as a normal Save, so needsRestart/scheduleAutoRefresh behave
// identically to a hand-edited settings dialog. The token, if any, is
// held back in pendingImportToken above rather than returned here --
// see settings:confirmImportToken.
ipcMain.handle('settings:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Print Catalog Settings',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || filePaths.length === 0) return { ok: false, cancelled: true };

  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(filePaths[0], 'utf8'));
  } catch (err) {
    throw new Error("That file isn't valid JSON.");
  }
  if (!raw || typeof raw !== 'object' || !raw.settings || typeof raw.settings !== 'object') {
    throw new Error("That file doesn't look like a Print Catalog settings export.");
  }

  const before = settingsStore.get();
  const saved = await settingsStore.save({ ...before, ...raw.settings });
  const needsRestart =
    before.gitRepoUrl !== saved.gitRepoUrl || (before.gitBranch || 'main') !== (saved.gitBranch || 'main');
  scheduleAutoRefresh();

  pendingImportToken = typeof raw.syncToken === 'string' && raw.syncToken ? raw.syncToken : null;

  return { ok: true, settings: saved, needsRestart, hasToken: Boolean(pendingImportToken) };
});

// Second step of a token import -- kept separate from settings:import
// so the admin gets an explicit, informed confirm() (in renderer.js)
// naming the fact that this overwrites the laptop's current token,
// before the admin-auth prompt pops. Discards pendingImportToken
// either way, so a declined import can't be silently applied later by
// some other path.
ipcMain.handle('settings:confirmImportToken', async (event, confirmed) => {
  const token = pendingImportToken;
  pendingImportToken = null;
  if (!confirmed || !token) return { ok: false };
  await writeSyncToken(token); // pops the native admin-auth prompt
  return { ok: true };
});


ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('sync:getStatus', async () => getSyncStatusPayload());

// Manual "refresh now" button (see renderer.js's #refresh-now-btn).
// runCatalogSync() already no-ops if a sync is already in flight, and
// broadcasts 'sync:statusChanged' as it starts/finishes, so the
// renderer doesn't need this call's return value for feedback -- it's
// just returned as a convenience for an immediate read.
ipcMain.handle('sync:refreshNow', () => {
  runCatalogSync();
  return getSyncStatusPayload();
});

app.whenReady().then(async () => {
  buildMenu();
  await loadSettings();

  if (!settingsStore.get().gitRepoUrl) {
    // Nothing to index yet -- there's no bundled seed data (see
    // resolveDataDir()), so a first launch with no repo configured
    // has no catalog to show. Skip setupIndexer entirely and open
    // straight to Settings instead of the normal window, requesting
    // required: true so the renderer can prevent dismissing it
    // without entering a repo URL. Once one is entered,
    // settings:save's existing needsRestart check already fires (it's
    // a gitRepoUrl before/after change), so this reuses the standard
    // "restart to apply" prompt/app:relaunch path rather than a
    // special case.
    createWindow();
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('menu:openSettings', { required: true });
    });
    return;
  }

  await setupIndexer();
  createWindow();
  runCatalogSync();
  scheduleAutoRefresh();
});

app.on('window-all-closed', () => {
  // Unlike the typical macOS convention (stay running with no windows,
  // relying on the Dock icon to reopen one), this app has no such
  // reopen path, so quit on every platform once the window is closed.
  app.quit();
});