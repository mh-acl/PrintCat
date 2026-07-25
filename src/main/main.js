'use strict';

const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
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

// Placeholder category every new item lands under until the real
// import wizard (folder validation, metadata.json, image
// reconciliation) exists to assign a proper one -- see
// runAddItemsToCatalog() below.
const FALLBACK_CATEGORY = 'New Items';

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

// "Add items to Print Catalog..." -- the first, bones-only slice of
// the co-admin import feature (see ARCHITECTURE.md). Deliberately does
// none of the niceties planned for later (image/print-file
// reconciliation, metadata.json, a staging queue for multiple items):
// picks one folder, drops it under a fixed placeholder category
// as-is, and pushes it -- relying on the existing filename-based
// parsing for everything else, same as the old hand-edited workflow.
//
// Doesn't go through tools.js's TOOLS registry like Cleanup profile
// does, and isn't wired as its own persistent window like USB Wiper --
// it needs a folder-picker result to feed into the rest of the flow,
// which doesn't fit either existing shape, so it's a standalone
// function wired directly into the Tools submenu below.
async function runAddItemsToCatalog() {
  const settings = settingsStore.get();
  if (!settings.gitRepoUrl) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Add items to Print Catalog',
      message: 'No Git repository is configured yet.',
      detail: 'Set one up in Settings before adding items.',
    });
    return;
  }

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a print item folder',
    properties: ['openDirectory'],
  });
  if (canceled || filePaths.length === 0) return;

  const sourceDir = filePaths[0];
  const folderName = path.basename(sourceDir);
  const destDir = path.join(DATA_DIR, FALLBACK_CATEGORY, folderName);

  let alreadyExists = true;
  try {
    await fsp.access(destDir);
  } catch (err) {
    alreadyExists = false;
  }
  if (alreadyExists) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Add items to Print Catalog',
      message: `"${folderName}" already exists in the catalog (under "${FALLBACK_CATEGORY}").`,
    });
    return;
  }

  try {
    await fsp.mkdir(path.dirname(destDir), { recursive: true });
    await fsp.cp(sourceDir, destDir, { recursive: true });

    // The chokidar watcher in setupIndexer() will pick this up and
    // show it in the running catalog immediately, before it's
    // committed or pushed anywhere -- that's fine as local-only
    // feedback, but if the co-admin backs out below, cleanUp()
    // removes it again rather than leaving an uncommitted item
    // sitting in the catalog until the next launch's hard reset
    // quietly discards it.
    const cleanUp = () => fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Push'],
      defaultId: 0,
      cancelId: 0,
      title: 'Add items to Print Catalog',
      message: `Push "${folderName}" to GitHub?`,
      detail: 'This will require admin authorization on this laptop.',
    });
    if (response !== 1) {
      await cleanUp();
      return;
    }

    try {
      const token = (await tokenExists())
        ? await readSyncToken()
        : await (async () => {
            const entered = await promptForToken(mainWindow);
            if (!entered) return null;
            await writeSyncToken(entered);
            return entered;
          })();

      if (!token) {
        // Admin cancelled the provisioning dialog -- not an error,
        // just back out the same way a "Cancel" on the push
        // confirmation above does.
        await cleanUp();
        return;
      }

      const result = await pushNewItem({
        targetDir: DATA_DIR,
        repoUrl: settings.gitRepoUrl,
        branch: settings.gitBranch || 'main',
        token,
        commitMessage: `Add item: ${folderName}`,
      });

      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Add items to Print Catalog',
        message:
          result.pushed === false
            ? `"${folderName}" was already up to date -- nothing to push.`
            : `"${folderName}" was added and pushed to GitHub.`,
      });
    } catch (err) {
      // A failed push here (bad auth, rejected non-fast-forward,
      // network) is left for the next launch's syncCatalogRepo() to
      // self-heal, same as any other gitSync failure -- see
      // ARCHITECTURE.md's "one-way mirror" note. We don't attempt our
      // own retry or force-push.
      await cleanUp();
      throw err;
    }
  } catch (err) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Add items to Print Catalog failed',
      message: err.message,
    });
  }
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
        { label: 'USB Wiper\u2026', click: () => openUsbWiperWindow() },
        { label: 'Add items to Print Catalog\u2026', click: () => runAddItemsToCatalog() },
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
  const watcher = chokidar.watch(DATA_DIR, { ignoreInitial: true });
  let rescanTimer = null;
  const scheduleRescan = () => {
    clearTimeout(rescanTimer);
    // Debounce -- a git pull touches many files in one burst.
    rescanTimer = setTimeout(async () => {
      const tree = await indexer.scan();
      if (mainWindow) mainWindow.webContents.send('catalog:updated', tree);
    }, 500);
  };
  watcher.on('add', scheduleRescan);
  watcher.on('change', scheduleRescan);
  watcher.on('unlink', scheduleRescan);
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
  };
}

function broadcastSyncStatus() {
  if (mainWindow) mainWindow.webContents.send('sync:statusChanged', getSyncStatusPayload());
}

// Kicks off the git sync without blocking startup. The catalog opens
// showing whatever was already on disk; if the sync changes anything,
// the chokidar watcher in setupIndexer() picks up the file events and
// pushes a fresh tree to the renderer on its own. In the common case
// (already up to date) this just adds a no-op fetch in the
// background; only when there's actually new data does a second scan
// happen.
function syncCatalogRepoInBackground() {
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
      console.warn('[gitSync] launch sync did not complete:', result.reason, result.error || '');
    }
    syncInProgress = false;
    broadcastSyncStatus();
  });
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

  const destPath = path.join(mountPoint, path.basename(sourcePath));
  await fsp.copyFile(resolvedSource, destPath);
  return destPath;
});

ipcMain.handle('drives:eject', async (event, diskIdentifier) => {
  await ejectDrive(diskIdentifier);
});

ipcMain.handle('drives:isPresent', async (event, diskIdentifier) => isDiskPresent(diskIdentifier));

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
  return { settings: saved, needsRestart };
});

ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('sync:getStatus', async () => getSyncStatusPayload());

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
  syncCatalogRepoInBackground();
});

app.on('window-all-closed', () => {
  // Unlike the typical macOS convention (stay running with no windows,
  // relying on the Dock icon to reopen one), this app has no such
  // reopen path, so quit on every platform once the window is closed.
  app.quit();
});