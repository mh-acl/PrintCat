'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// Small modal window used once per laptop, the first time
// runAddItemsToCatalog() (in main.js) attempts a push and finds
// tokenStore.js's tokenExists() is false. Just a plain text field --
// deliberately no extra gating in this window itself. The real gate is
// the native macOS admin-authentication prompt that tokenStore.js's
// writeSyncToken() pops immediately after this resolves: anyone can
// open this dialog and paste something into it, but only someone who
// can satisfy that OS prompt actually gets it written to disk, so
// there's nothing this window itself needs to protect against.
//
// Resolves with the entered token (trimmed, non-empty), or null if the
// admin cancels or closes the window without submitting anything.
function promptForToken(parentWindow) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 480,
      height: 280,
      parent: parentWindow,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'provisionTokenPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'provisionTokenWindow.html'));

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeHandler('provisionToken:submit');
      ipcMain.removeHandler('provisionToken:cancel');
      if (!win.isDestroyed()) win.close();
      resolve(value);
    };

    // handleOnce rather than handle -- this window (and these
    // channels) only ever needs to handle a single submission, and
    // self-removing avoids a "second handler for this channel"
    // collision if promptForToken() is ever called again in the same
    // app session (e.g. the admin cancels the first attempt and
    // retries the push).
    ipcMain.handleOnce('provisionToken:submit', (event, token) => {
      finish(token && token.trim() ? token.trim() : null);
    });
    ipcMain.handleOnce('provisionToken:cancel', () => finish(null));

    // Catch-all for the OS close button / Escape, which don't go
    // through either IPC channel above -- finish()'s settled guard
    // makes this safe to call even after an explicit submit/cancel
    // already resolved things.
    win.on('closed', () => finish(null));
  });
}

module.exports = { promptForToken };
