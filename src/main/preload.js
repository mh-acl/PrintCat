'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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
});