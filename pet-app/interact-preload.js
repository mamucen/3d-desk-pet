// 互动应用面板的桥：只暴露这一屏需要的几个动作
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('InteractHost', {
  get: () => ipcRenderer.invoke('interact:get'),
  setOn: (v) => ipcRenderer.send('interact:set-on', !!v),
  // patch: { allow?, schedOn?, time? }
  setApp: (key, patch) => ipcRenderer.send('interact:set-app', Object.assign({ key: key }, patch || {})),
  open: (key) => ipcRenderer.send('interact:open', key),
  test: (key) => ipcRenderer.send('interact:test', key),
  addExe: () => ipcRenderer.send('interact:add-exe'),
  del: (key) => ipcRenderer.send('interact:del', key),
  close: () => ipcRenderer.send('interact:close'),
  onState: (cb) => ipcRenderer.on('interact:state', (e, s) => cb(s))
});
