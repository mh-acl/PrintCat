'use strict';

// settings.js
//
// Small persisted store for admin-configured app settings -- currently
// just which printer models this makerspace actually has, and whether
// to hide any others entirely. This is different from the per-session
// printer filter choice a user makes while browsing: settings here are
// meant to be set once by whoever administers the shared laptop and
// persist across launches and users.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DEFAULT_SETTINGS = {
  // Printer labels (e.g. "MK4S 0.4") this makerspace actually has.
  // Empty means "not configured yet" -- treated as no restriction.
  availablePrinters: [],
  // If true, only availablePrinters are ever selectable/visible in the
  // browsing filter at all. If false, availablePrinters still sets the
  // default pre-filter, but every printer remains choosable.
  hideUnavailable: false,
  // Public HTTPS git repo to sync catalog data from (replaces the old
  // PRINTCAT_GIT_REPO_URL env var). Empty means git sync is off --
  // DATA_DIR falls back to PRINTCAT_DATA_DIR / the dev-time default.
  gitRepoUrl: '',
  // Branch to track (replaces PRINTCAT_GIT_BRANCH). Stored as typed;
  // an empty value defaults to 'main' wherever it's consumed (gitSync.js
  // and main.js), not here, so the settings dialog can show a blank
  // field rather than a filled-in 'main'.
  gitBranch: '',
  // USB Wiper's "Rename drive to:" checkbox + text field (see
  // usbWiperWindow.js) -- persisted so both the on/off state and the
  // last-typed name are remembered the next time the tool window is
  // opened, independent of any single wipe session.
  renameDrives: false,
  driveRenameName: 'UNTITLED',
};

class SettingsStore {
  constructor({ settingsFile }) {
    this.settingsFile = settingsFile;
    this.settings = { ...DEFAULT_SETTINGS };
  }

  async load() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.settingsFile, 'utf8'));
      this.settings = { ...DEFAULT_SETTINGS, ...raw };
    } catch (err) {
      this.settings = { ...DEFAULT_SETTINGS }; // no settings file yet, or it's corrupt
    }
    return this.settings;
  }

  async save(newSettings) {
    this.settings = { ...DEFAULT_SETTINGS, ...newSettings };
    await fsp.mkdir(path.dirname(this.settingsFile), { recursive: true });
    await fsp.writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2));
    return this.settings;
  }

  get() {
    return this.settings;
  }
}

module.exports = { SettingsStore, DEFAULT_SETTINGS };
