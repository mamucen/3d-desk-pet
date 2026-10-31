// 快捷输入条渲染进程桥
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('QN', {
  onFill: (cb) => ipcRenderer.on('qn:fill', (e, p) => cb(p || {})),
  onOk: (cb) => ipcRenderer.on('qn:ok', (e, p) => cb(p || {})),
  onError: (cb) => ipcRenderer.on('qn:error', (e, msg) => cb(String(msg || ''))),
  submit: (text) => ipcRenderer.send('qn:submit', text),
  hide: () => ipcRenderer.send('qn:hide')
});
