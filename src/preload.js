'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  providers: () => ipcRenderer.invoke('providers:meta'),
  i18n: () => ipcRenderer.invoke('i18n:get'),
  getState: () => ipcRenderer.invoke('state:get'),
  refreshAll: () => ipcRenderer.invoke('refresh:all'),
  refreshOne: (id) => ipcRenderer.invoke('refresh:one', id),
  openLogin: (id) => ipcRenderer.invoke('login:open', id),
  clearLogin: (id) => ipcRenderer.invoke('login:clear', id),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  onUpdate: (cb) => { ipcRenderer.on('provider:update', (_e, p) => cb(p)); },
  onLoading: (cb) => { ipcRenderer.on('provider:loading', (_e, p) => cb(p)); },
  platform: process.platform,
});
