'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  openFiles: (opts) => ipcRenderer.invoke('file:open', opts),
  saveFile: (opts) => ipcRenderer.invoke('file:save', opts),
  saveSeq: (opts) => ipcRenderer.invoke('file:saveSeq', opts),
  saveMany: (opts) => ipcRenderer.invoke('file:saveMany', opts),
  openFolder: (opts) => ipcRenderer.invoke('file:openFolder', opts),
  writeFile: (id, data) => ipcRenderer.invoke('file:write', id, data),
  readFile: (id) => ipcRenderer.invoke('file:read', id),
  recentList: () => ipcRenderer.invoke('recent:list'),
  recentOpen: (id) => ipcRenderer.invoke('recent:open', id),
  recentStar: (id) => ipcRenderer.invoke('recent:star', id),
  recentClear: () => ipcRenderer.invoke('recent:clear'),
  info: () => ipcRenderer.invoke('app:info'),
  setLang: (l) => ipcRenderer.send('app:lang', String(l)),
  launchFiles: () => ipcRenderer.invoke('app:launchFiles'),
  
});
