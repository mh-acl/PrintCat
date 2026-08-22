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
  getSyncStatus: () => ipcRenderer.invoke('sync:getStatus'),
  onSyncStatusChanged: (callback) => {
    ipcRenderer.on('sync:statusChanged', (event, status) => callback(status));
  },
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  onEditSessionEntered: (callback) => {
    ipcRenderer.on('editSession:entered', () => callback());
  },
  editSessionPickAddFolder: () => ipcRenderer.invoke('editSession:pickAddFolder'),
  editSessionPrepareAddFolder: (sourceDir) => ipcRenderer.invoke('editSession:prepareAddFolder', sourceDir),
  editSessionBrowseImages: () => ipcRenderer.invoke('editSession:browseImages'),
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