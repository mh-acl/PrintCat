'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('provisionTokenAPI', {
  submit: (token) => ipcRenderer.invoke('provisionToken:submit', token),
  cancel: () => ipcRenderer.invoke('provisionToken:cancel'),
});
