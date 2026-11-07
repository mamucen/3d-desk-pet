// 渲染进程桥：把主进程能力以安全的方式暴露给页面
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('PetHost', {
  active: true,

  init: (cb) => ipcRenderer.once('pet:init', (e, s) => cb(s)),

  onCursor: (cb) => ipcRenderer.on('pet:cursor', (e, p) => cb(p)),

  moveTo: (x, y) => ipcRenderer.send('pet:move', x, y),

  setClickThrough: (v) => ipcRenderer.send('pet:clickthrough', v),

  setFollowing: (v) => ipcRenderer.send('pet:follow-state', v),

  setAlwaysTop: (v) => ipcRenderer.send('pet:always-top', v),

  onFollow: (cb) => ipcRenderer.on('pet:follow', (e, v) => cb(v)),
  onTop: (cb) => ipcRenderer.on('pet:top', (e, v) => cb(v)),
  onReset: (cb) => ipcRenderer.on('pet:reset', () => cb()),

  onDragEnd: (cb) => ipcRenderer.on('pet:drag-end', (e) => cb()),

  // ---- 系统负载（CPU / 内存） ----
  onSys: (cb) => ipcRenderer.on('pet:sys', (e, p) => cb(p)),

  // ---- 皮肤（主进程把设置里的皮肤推给页面） ----
  onSkin: (cb) => ipcRenderer.on('pet:skin', (e, id) => cb(id)),

  // ---- 游荡模式 ----
  onWander: (cb) => ipcRenderer.on('pet:wander', (e, v) => cb(v)),
  setWander: (v) => ipcRenderer.send('pet:wander-state', v),

  // ---- 游荡时"看见"了什么窗口（只读标题，主进程已做安全过滤） ----
  onPeek: (cb) => ipcRenderer.on('pet:peek', (e, p) => cb(p)),

  // ---- 主进程让它说句话 ----
  onSay: (cb) => ipcRenderer.on('pet:say', (e, t) => cb(t)),

  // ---- 桌面专属动作（随手记 / 剪贴板 / 隐身 / 陪看），由右下角菜单触发 ----
  hostCmd: (name) => ipcRenderer.send('pet:host-cmd', name),

  // ---- 原生右键菜单：页面把当前状态报给主进程，主进程弹系统菜单，动作再回传 ----
  menu: (state) => ipcRenderer.send('pet:menu', state || {}),
  onMenuCmd: (cb) => ipcRenderer.on('pet:menu-cmd', (e, act) => cb(act)),

  // ---- 与「信息管家」的联动 ----
  onLink: (cb) => ipcRenderer.on('pet:link', (e, p) => cb(p)),
  requestLink: () => ipcRenderer.send('pet:link-request'),
  linkCmd: (cmd) => ipcRenderer.send('pet:link-cmd', cmd),

  quit: () => ipcRenderer.send('pet:quit')
});
