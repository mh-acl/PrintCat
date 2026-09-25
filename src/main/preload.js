'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('catalogAPI', {
  getTree: () => ipcRenderer.invoke('catalog:getTree'),
  getItemThumbnail: (itemNode) => ipcRenderer.invoke('catalog:getItemThumbnail', itemNode),
  getFileThumbnail: (fileEntry, imageFiles) =>
    ipcRenderer.invoke('catalog:getFileThumbnail', fileEntry, imageFiles),
  onCatalogUpdated: (callback) => {
    ipcRenderer.on('catalog:updated', (event, tree) => callback(tree));
  },
  onOpenSettings: (callback) => {
    ipcRenderer.on('menu:openSettings', (event, payload) => callback(payload));
  },
  listDrives: () => ipcRenderer.invoke('drives:list'),
  saveFileToDrive: (sourcePath, mountPoint) =>
    ipcRenderer.invoke('drives:saveFile', sourcePath, mountPoint),
  ejectDrive: (diskIdentifier) => ipcRenderer.invoke('drives:eject', diskIdentifier),
  isDrivePresent: (diskIdentifier) => ipcRenderer.invoke('drives:isPresent', diskIdentifier),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  exportSettings: (opts) => ipcRenderer.invoke('settings:export', opts),
  importSettings: () => ipcRenderer.invoke('settings:import'),
  confirmImportToken: (confirmed) => ipcRenderer.invoke('settings:confirmImportToken', confirmed),
  getSyncStatus: () => ipcRenderer.invoke('sync:getStatus'),
  refreshCatalogNow: () => ipcRenderer.invoke('sync:refreshNow'),
  onSyncStatusChanged: (callback) => {
    ipcRenderer.on('sync:statusChanged', (event, status) => callback(status));
  },
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  // Pushed by autoUpdate.js throughout an accepted update (download
  // progress, unzip, final "closing" message, or a close on failure) --
  // see dialogs.js's handleUpdateProgress().
  onUpdateProgress: (callback) => {
    ipcRenderer.on('update:progress', (event, payload) => callback(payload));
  },
  onEditSessionEntered: (callback) => {
    ipcRenderer.on('editSession:entered', () => callback());
  },
  // "Discard Edits" app-menu item -- see main.js's buildMenu()/
  // discardEditsFromMenu() and renderer.js's init().
  onDiscardEdits: (callback) => {
    ipcRenderer.on('menu:discardEdits', () => callback());
  },
  // Pushed by main.js after a main-process-triggered session mutation
  // (currently just the native "Backfill Added Dates" Tools-menu item)
  // that has no renderer-initiated invoke() call to carry a response
  // back through -- see main.js's backfillAddedDatesTask().
  onEditSessionChangesUpdated: (callback) => {
    ipcRenderer.on('editSession:changesUpdated', (event, payload) => callback(payload));
  },
  editSessionPickAddFolder: () => ipcRenderer.invoke('editSession:pickAddFolder'),
  editSessionPrepareAddFolder: (sourceDir) => ipcRenderer.invoke('editSession:prepareAddFolder', sourceDir),
  editSessionBrowseImages: () => ipcRenderer.invoke('editSession:browseImages'),
  editSessionBrowsePrintFiles: () => ipcRenderer.invoke('editSession:browsePrintFiles'),
  editSessionParseNewPrintFile: (filePath) => ipcRenderer.invoke('editSession:parseNewPrintFile', filePath),
  detectItemOrigin: (itemPath) => ipcRenderer.invoke('editSession:detectOrigin', itemPath),
  backfillOrigins: () => ipcRenderer.invoke('editSession:backfillOrigins'),
  // webUtils.getPathForFile must be called from here (preload), not the
  // renderer -- it's the only supported way to get a real filesystem
  // path back from a dropped File object with contextIsolation on.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  editSessionCommitAdd: (sourceDir, fields) => ipcRenderer.invoke('editSession:commitAdd', sourceDir, fields),
  editSessionCommitEdit: (itemPath, fields) => ipcRenderer.invoke('editSession:commitEdit', itemPath, fields),
  editSessionDeleteItem: (itemPath) => ipcRenderer.invoke('editSession:deleteItem', itemPath),
  editSessionUndoDelete: (itemPath) => ipcRenderer.invoke('editSession:undoDelete', itemPath),
  editSessionCancel: () => ipcRenderer.invoke('editSession:cancelSession'),
  editSessionConfirm: () => ipcRenderer.invoke('editSession:confirmSession'),
});