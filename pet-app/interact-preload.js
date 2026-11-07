// 互动应用面板的桥：只暴露这一屏需要的几个动作
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('InteractHost', {
  get: () => ipcRenderer.invoke('interact:get'),
  setOn: (v) => ipcRenderer.send('interact:set-on', !!v),
  setApp: (id, on) => ipcRenderer.send('interact:set-app', { id, on: !!on }),
  test: (id) => ipcRenderer.send('interact:test', id),
  add: (data) => ipcRenderer.send('interact:add', data || {}),
  del: (id) => ipcRenderer.send('interact:del', id),
  close: () => ipcRenderer.send('interact:close'),
  onState: (cb) => ipcRenderer.on('interact:state', (e, s) => cb(s))
});
