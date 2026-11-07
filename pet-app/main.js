// 3D 桌面小机器人 · Electron 主进程
// 透明无边框 + 置顶 + 不占任务栏 + 系统托盘常驻
'use strict';

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, globalShortcut, clipboard, desktopCapturer, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createBridge } = require('./bridge');
const { isFullscreenish } = require('./fullscreen');
const { createOutbox } = require('./outbox');
const { createWatcher, cleanTitle, listPendingSessions, markSessionSent, dropSession, adoptLegacySessions, noteSessionAttempt, MAX_TRIES } = require('./watch');
const { buildReport } = require('./report');
const bili = require('./bili');
const { APPS: INTERACT_APPS, SYSTEM_EVENTS, NEVER: INTERACT_NEVER } = require('./interact-apps');

const WIN_W = 164;
const WIN_H = 252;
const QN_W = 460;      // 快捷输入条
const QN_H = 62;

// 信息管家线上地址（含分享码）。平台的分享链接必须带 sharecode，
// 少了会被判定「链接不完整」直接 403，所以这里一定要带全。
const DEFAULT_APP_URL = 'https://info-keeper-21227.app.workbuddy.host/?sharecode=BRPXR3GO4G';
const DEFAULT_SHARECODE = (/(?:^|[?&])sharecode=([^&#]+)/.exec(DEFAULT_APP_URL) || [])[1] || '';

// 只认信息管家的正式地址：*.workbuddy.host / *.workbuddy.cn（含 app.workbuddy.host），
// 或本机调试的 localhost。早先版本收任何“带点的域名”，结果测试脚本里的占位域名
// （info-keeper.example）趁测试运行时被推给了真机器人，还写进了缓存，
// 点「记一条」就打开了打不开的假网址。这里直接白名单，一劳永逸。
function pickUrl(u) {
  if (typeof u !== 'string') return '';
  const s = u.trim();
  const m = /^(https?:\/\/[^\/\s?#]+)/i.exec(s);
  if (!m) return '';
  const host = m[1].replace(/^https?:\/\//i, '').split(':')[0].toLowerCase();
  if (host === 'localhost') return s;
  if (/(^|\.)workbuddy\.host$/.test(host)) return s;
  if (/(^|\.)workbuddy\.cn$/.test(host)) return s;
  return '';
}

// 白名单之外再补一道：分享链接缺 sharecode 会 403，这里自动补齐
function appUrl(u) {
  const s = pickUrl(u);
  if (!s) return '';
  if (/[?&]sharecode=/.test(s)) return s;
  try {
    const url = new URL(s);
    if (!/(^|\.)workbuddy\.(host|cn)$/.test(url.hostname)) return s;
    if (DEFAULT_SHARECODE) url.searchParams.set('sharecode', DEFAULT_SHARECODE);
    return url.toString();
  } catch (e) {
    return s;
  }
}

let win = null;
let qnWin = null;
let tray = null;
let cursorTimer = null;
let linkTimer = null;
let bridge = null;
let quitting = false;
let restarting = false;

/**
 * 重启自己：改完代码不用去托盘里翻「退出」再双击。
 * 先把 quitting 立起来，让 close 处理器放行；before-quit 里那套清理照常跑
 * （定时器、陪看会话、桥接端口都会释放），然后由 Electron 拉一个新进程。
 */
function restartApp() {
  if (restarting) return;
  restarting = true;
  quitting = true;
  try {
    // 开发态 argv 是 [electron.exe, 工程目录]，必须显式把目录带回去；
    // 打包后原样重放启动参数。都追加 --relaunch 标记，让新进程知道“这是重启，值得等锁”。
    const base = app.isPackaged ? process.argv.slice(1) : [app.getAppPath()];
    app.relaunch({ execPath: process.execPath, args: base.concat(['--relaunch']) });
  } catch (e) {
    try { app.relaunch(); } catch (err) { /* 实在不行就只退出 */ }
  }
  app.quit();
  // 兜底：万一有东西拦住退出，两秒后硬退（不然“重启”变成“卡住”）
  setTimeout(() => { try { app.exit(0); } catch (e) { /* 忽略 */ } }, 2000);
}

const state = { follow: false, top: true };

// 最近一次联动状态（离线时也保留，重启后先显示上次的数字）
let link = { online: false, state: null, appUrl: DEFAULT_APP_URL };
let stateFile = '';
let settingsFile = '';
const settings = {
  autoStart: false, autoHide: true, watchMode: true, skin: 'robot', wander: false, study: true, ybcUnlocked: false,
  // 互动应用：allow 里为 true 的应用才搭理；custom 是用户自己加的关键词
  interact: { on: true, allow: { doubao: true }, custom: [], greetBack: true, bt: false }
};

/* ---------- 皮肤 ---------- */
const SKINS = [
  { id: 'robot',   name: '经典机器人' },
  { id: 'pixel',   name: '像素喵' },
  { id: 'stellar', name: '星际喵' },
  { id: 'rich',    name: '暴富喵' },
  { id: 'camera',  name: '镜头喵' },
  { id: 'pubg',    name: '和平精英喵' },
  { id: 'samurai', name: '武士喵' },
  { id: 'hotpot',  name: '火锅喵' },
  { id: 'deepsea', name: '深海喵' },
  { id: 'ghost',   name: '夜光喵' },
  { id: 'ybc',     name: '猿编程喵', locked: true }   // 隐藏款：打开猿编程才解锁
];
function applySkinChoice(id) {
  if (!SKINS.some((s) => s.id === id)) id = 'robot';
  // 隐藏款守卫：没解锁时，菜单/外部接口都换不上
  if (id === 'ybc' && !settings.ybcUnlocked) {
    petSay('「猿编程喵」是隐藏款！打开猿编程写一次代码就能解锁。');
    return;
  }
  settings.skin = id;
  saveSettings();
  if (win && !win.isDestroyed()) win.webContents.send('pet:skin', id);
  if (tray) tray.setContextMenu(buildTrayMenu());
}
function skinSubmenu() {
  return SKINS.map((s) => {
    if (s.locked && !settings.ybcUnlocked) {
      return {
        label: '猿编程喵 🔒（打开猿编程解锁）',
        click: () => petSay('这是隐藏款「猿编程喵」！打开猿编程写一次代码就会解锁。')
      };
    }
    return {
      label: s.name,
      type: 'checkbox',
      checked: (settings.skin || 'robot') === s.id,
      click: () => applySkinChoice(s.id)
    };
  });
}

/* ---------- 待同步队列（outbox） ----------
   桌面记的东西先落盘，网页一打开就自动灌进去。
   这样即使管家没开着，按 Ctrl+Alt+Space 记也不会丢。 */
let outboxFile = '';
let outbox = null;

function loadOutbox() {
  try {
    outboxFile = path.join(app.getPath('userData'), 'outbox.json');
  } catch (err) { outboxFile = ''; }
  outbox = createOutbox(outboxFile);
  outbox.load();
  return outbox.list();
}

function outboxCount() { return outbox ? outbox.count() : 0; }

/** 把还没送出去的条目推给网页（在线时才真的送） */
function flushOutbox() {
  if (!outbox || !bridge || !bridge.isOnline()) return false;
  const todo = outbox.due();
  if (!todo.length) return false;
  outbox.markSent(todo);
  return bridge.push({
    cmd: 'ingest',
    items: todo.map((x) => ({ id: x.id, text: x.text, at: x.at, tries: x.tries }))
  });
}

/* ---------- 设置（开机自启 / 全屏隐身） ---------- */
function loadSettings() {
  try {
    settingsFile = path.join(app.getPath('userData'), 'pet-settings.json');
    if (fs.existsSync(settingsFile)) {
      const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        settings.autoStart = !!raw.autoStart;
        if (typeof raw.autoHide === 'boolean') settings.autoHide = raw.autoHide;
        if (typeof raw.watchMode === 'boolean') settings.watchMode = raw.watchMode;
        if (typeof raw.skin === 'string' && raw.skin) settings.skin = raw.skin;
        if (typeof raw.wander === 'boolean') settings.wander = raw.wander;
        if (typeof raw.study === 'boolean') settings.study = raw.study;
        if (typeof raw.ybcUnlocked === 'boolean') settings.ybcUnlocked = raw.ybcUnlocked;
        if (raw.interact && typeof raw.interact === 'object') {
          const it = raw.interact;
          if (typeof it.on === 'boolean') settings.interact.on = it.on;
          if (it.allow && typeof it.allow === 'object') settings.interact.allow = it.allow;
          if (Array.isArray(it.custom)) settings.interact.custom = it.custom.filter((c) => c && c.name);
          if (typeof it.greetBack === 'boolean') settings.interact.greetBack = it.greetBack;
          if (typeof it.bt === 'boolean') settings.interact.bt = it.bt;
        }
      }
    }
  } catch (err) { /* 用默认值 */ }
  // 以系统里真实的登录项为准，避免两边不一致
  settings.autoStart = readAutoStart();
}

function saveSettings() {
  try {
    if (settingsFile) fs.writeFileSync(settingsFile, JSON.stringify(settings));
  } catch (err) { /* ignore */ }
}

/* 开机自启：自己写 HKCU 的 Run 项，不用 Electron 的 setLoginItemSettings。
   原因：那个 API 用 app 名字当注册表值名，未打包时会变成 electron.app.Electron，
   跟机器上别的 Electron 应用互相覆盖。这里的值名固定为 3DDeskPet。 */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = '3DDeskPet';

function readAutoStart() {
  // 只用 Electron 自带 API（读 Run 键），绝不起 reg 子进程：
  // 本机安全策略把 reg.exe 列在黑名单里，一旦启动会连坐杀掉整棵进程树，
  // 之前「点开机自启就消失」就是这么来的。
  try {
    const st = app.getLoginItemSettings({ path: process.execPath });
    return st.openAtLogin === true;
  } catch (err) {
    return false;
  }
}

function loginItemTarget() {
  // 打包后 exe 自己就能启动；开发态（electron.exe 跑目录）要把应用目录带上，
  // 否则开机会开一个空白 Electron。
  return {
    exe: process.execPath,
    args: app.isPackaged ? [] : [path.resolve(__dirname, '..')],
  };
}

function applyAutoStart(on) {
  settings.autoStart = !!on;
  // 全部走 Electron 原生接口：不启动 reg.exe（本机安全策略一旦看到 reg
  // 就会杀掉整个应用），也就没有进程被连坐的风险。
  // 代价：Run 键的值名由 Electron 用应用名生成（旧版本是 3DDeskPet），
  // 升级后首次勾选会多一条同名项——但启动行为是一致的。
  try {
    const t = loginItemTarget();
    app.setLoginItemSettings({
      openAtLogin: settings.autoStart,
      path: t.exe,
      args: t.args
    });
  } catch (err) { /* 接口不可用就只在设置里记着 */ }
  saveSettings();
  try { if (tray) tray.setContextMenu(buildTrayMenu()); } catch (err) { /* ignore */ }
}

/* ---------- 找到渲染页面 ---------- */
function findHtml() {
  const cands = [
    path.join(__dirname, 'renderer', 'robot-pet-3d.html'),
    path.join(__dirname, '..', 'robot-pet-3d.html'),
    path.join(__dirname, 'robot-pet-3d.html')
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return null;
}

/* ---------- 窗口 ---------- */
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: wa.x + wa.width - WIN_W - 48,
    y: wa.y + wa.height - WIN_H - 48,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false   // 关键：失焦后动画照常跑，不会“反应变慢”
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 默认鼠标穿透（forward 让渲染进程仍能拿到移动事件），悬停到机器人上时再打开
  win.setIgnoreMouseEvents(true, { forward: true });

  win.once('ready-to-show', () => win.show());

  const html = findHtml();
  if (html) win.loadFile(html);
  else win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="font-family:sans-serif"><h3>未找到 robot-pet-3d.html</h3><p>请把它放在 pet-app 同级目录。</p></body>'));

  win.webContents.on('did-finish-load', () => {
    const b = win.getBounds();
    win.webContents.send('pet:init', {
      x: b.x, y: b.y,
      workArea: screen.getPrimaryDisplay().workArea
    });
    win.webContents.send('pet:link', link);
    win.webContents.send('pet:skin', settings.skin || 'robot');
    win.webContents.send('pet:wander', settings.wander);

    // 调试：PET_DEBUG_SHOT=毫秒数 时自动截一张渲染画面（默认 1800ms）
    if (process.env.PET_DEBUG_SHOT) {
      const delay = parseInt(process.env.PET_DEBUG_SHOT, 10) || 1800;
      setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        win.webContents.executeJavaScript(
          'var b=document.getElementById("badge");' +
          'var r=b.getBoundingClientRect();' +
          'JSON.stringify({cls:b.className,num:document.getElementById("badgeNum").textContent,' +
          'rect:[r.x,r.y,r.width,r.height],op:getComputedStyle(b).opacity})'
        ).then((s) => console.log('[debug] badge:', s)).catch((e) => console.log('[debug] eval fail', e));
        win.webContents.capturePage().then((img) => {
          const out = path.join(__dirname, '..', '.shots', 'electron-render.png');
          fs.writeFileSync(out, img.toPNG());
          console.log('[debug] saved', out);
        }).catch((err) => console.log('[debug] capture failed', err));
      }, delay);
    }
  });

  win.on('closed', () => { win = null; });

  // 点 × 不退出：隐藏到托盘，真正退出走托盘菜单
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
  } else {
    win.show();
    win.focus();
  }
}

/** 让机器人说一句话（气泡） */
function petSay(text) {
  if (win && !win.isDestroyed()) win.webContents.send('pet:say', String(text || ''));
}

/* ---------- 外部程序指令 ----------
   猿编程的 Python 代码（或其他本机程序）通过桥接接口指挥桌宠：
   POST /pet/say {"text":"..."} → 说话；POST /pet/skin {"id":"samurai"} → 换肤；
   POST /pet/act {"action":"show|hide|follow"} → 现身/隐身/跟随开关。
   只收白名单动作，全是可逆的展示类操作。 */
function handlePetCommand(cmd) {
  try {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.action === 'say') {
      petSay(cmd.text);
    } else if (cmd.action === 'skin') {
      applySkinChoice(cmd.id);
    } else if (cmd.action === 'act') {
      if (cmd.act === 'hide') {
        if (win && !win.isDestroyed()) win.hide();
      } else if (cmd.act === 'show') {
        showWindow();
      } else if (cmd.act === 'follow') {
        state.follow = !state.follow;
        if (win && !win.isDestroyed()) win.webContents.send('pet:follow', state.follow);
      }
    }
  } catch (err) { /* 忽略 */ }
}

/* ---------- 快捷输入条 ----------
   Ctrl+Alt+Space 随手记一条；Ctrl+Alt+V 直接把剪贴板里的东西收进来。
   条子贴在机器人头顶，回车存档、Esc 走人。 */
function quickNotePos() {
  const wa = screen.getPrimaryDisplay().workArea;
  let cx, baseY;
  if (win && !win.isDestroyed() && win.isVisible()) {
    const b = win.getBounds();
    cx = b.x + b.width / 2;
    baseY = b.y;
  } else {
    const p = screen.getCursorScreenPoint();
    cx = p.x;
    baseY = p.y - 60;
  }
  let x = Math.round(cx - QN_W / 2);
  let y = Math.round(baseY - QN_H - 8);
  x = Math.max(wa.x + 8, Math.min(wa.x + wa.width - QN_W - 8, x));
  if (y < wa.y + 8) y = Math.round(baseY + 220);
  y = Math.max(wa.y + 8, Math.min(wa.y + wa.height - QN_H - 8, y));
  return { x, y };
}

function openQuickNote(opts) {
  const o = opts || {};
  if (qnWin && !qnWin.isDestroyed()) {
    const p = quickNotePos();
    qnWin.setPosition(p.x, p.y);
    qnWin.show();
    qnWin.focus();
    qnWin.webContents.send('qn:fill', { text: o.text || '', hint: o.hint || '', count: outboxCount() });
    return;
  }

  const p = quickNotePos();
  qnWin = new BrowserWindow({
    width: QN_W,
    height: QN_H,
    x: p.x,
    y: p.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'quicknote-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  qnWin.setAlwaysOnTop(true, 'screen-saver');
  qnWin.loadFile(path.join(__dirname, 'quicknote.html'));
  qnWin.once('ready-to-show', () => {
    if (!qnWin || qnWin.isDestroyed()) return;
    qnWin.show();
    qnWin.focus();
    qnWin.webContents.send('qn:fill', { text: o.text || '', hint: o.hint || '', count: outboxCount() });
  });
  // 点到别处就收起，符合“随手记一下”的用法
  qnWin.on('blur', () => closeQuickNote());
  qnWin.on('closed', () => { qnWin = null; });
}

function closeQuickNote() {
  if (qnWin && !qnWin.isDestroyed() && qnWin.isVisible()) qnWin.hide();
}

/** 剪贴板快收：有图优先存图，否则把文字预填进输入条让人确认 */
function clipboardHarvest() {
  let text = '';
  try { text = clipboard.readText() || ''; } catch (e) { text = ''; }
  const trimmed = text.trim();

  if (!trimmed) {
    let img = null;
    try { img = clipboard.readImage(); } catch (e) { img = null; }
    if (img && !img.isEmpty()) {
      try {
        const dir = path.join(app.getPath('userData'), 'clips');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'clip-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png');
        fs.writeFileSync(file, img.toPNG());
        petSay('截图收到，存在 clips\\' + path.basename(file));
        try { shell.showItemInFolder(file); } catch (e) { /* ignore */ }
        return;
      } catch (err) {
        petSay('截图存不下来：' + (err.message || '写入失败'));
        return;
      }
    }
    petSay('剪贴板是空的，先复制点东西？');
    return;
  }

  openQuickNote({ text: trimmed.slice(0, 2000), hint: '来自剪贴板 · 回车存档' });
}

/** 系统负载：机箱面板太小，浏览器里看曲线才过瘾 */
function openStatusPage() {
  const port = bridge && bridge.getPort();
  if (!port) { petSay('本地服务还没起来，先看看机箱面板吧。'); return; }
  try { shell.openExternal('http://127.0.0.1:' + port + '/status'); } catch (e) { /* 忽略 */ }
}

/* ---------- 全屏自动隐身 ----------
   判据：应用真全屏时任务栏被盖住 → workArea 等于屏幕 bounds。
   若系统本来就开着“任务栏自动隐藏”，这个判据失效，自动降级为只用快捷键。 */
let fsTimer = null;
let fsHideAt = 0;
let fsHidden = false;
let fsUsable = true;
let manualHidden = false;

function setFsHidden(on) {
  fsHidden = !!on;
  if (!win || win.isDestroyed()) return;
  if (fsHidden) win.hide();
  else if (!manualHidden) win.showInactive();
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function toggleManualHide() {
  manualHidden = !manualHidden;
  if (!win || win.isDestroyed()) return;
  if (manualHidden) win.hide();
  else win.showInactive();
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function startFullscreenWatch() {
  const d = screen.getPrimaryDisplay();
  fsUsable = !isFullscreenish(d.workArea, d.bounds);
  if (!fsUsable) console.log('[fullscreen] 任务栏常隐，自动隐身判据不可用，改用 Ctrl+Alt+H');

  fsTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    if (!fsUsable || !settings.autoHide) {
      if (fsHidden) setFsHidden(false);
      return;
    }
    if (manualHidden) return;

    const dd = screen.getPrimaryDisplay();
    const full = isFullscreenish(dd.workArea, dd.bounds);
    if (full) {
      if (!fsHideAt) fsHideAt = Date.now();
      if (!fsHidden && Date.now() - fsHideAt > 1500) setFsHidden(true);   // 抖一下就切走的不算
    } else {
      fsHideAt = 0;
      if (fsHidden) setFsHidden(false);
    }
  }, 1000);
}

/* ---------- 系统负载采样（CPU / 内存，供机器人“说出来”） ---------- */
function readCpuTimes() {
  const cpus = os.cpus() || [];
  let idle = 0, total = 0, cores = [];
  for (const c of cpus) {
    const t = c.times;
    if (!t) continue;
    const sum = t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle; total += sum;
    cores.push({ sum, idle: t.idle });
  }
  return { idle, total, cores, count: cpus.length };
}

let sysPrev = null, sysTimer = null;
const sysHistory = [];        // 最近的系统采样，给浏览器版监控页画曲线用
let lastSys = null;

function sampleSys() {
  const cur = readCpuTimes();
  if (!cur.total) return null;
  if (!sysPrev) { sysPrev = cur; return null; }
  const dTotal = cur.total - sysPrev.total;
  const dIdle = cur.idle - sysPrev.idle;
  // 单核占用：看最忙的那个核（多线程程序更容易顶满单核）
  let coreMax = 0;
  if (sysPrev.cores.length === cur.cores.length) {
    for (let i = 0; i < cur.cores.length; i++) {
      const ds = cur.cores[i].sum - sysPrev.cores[i].sum;
      const di = cur.cores[i].idle - sysPrev.cores[i].idle;
      if (ds > 0) coreMax = Math.max(coreMax, (1 - di / ds) * 100);
    }
  }
  sysPrev = cur;
  if (dTotal <= 0) return null;

  const totalMem = os.totalmem(), freeMem = os.freemem();
  return {
    cpu: Math.round(Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100))),
    coreMax: Math.round(Math.max(0, Math.min(100, coreMax))),
    mem: Math.round(Math.max(0, Math.min(100, (1 - freeMem / totalMem) * 100))),
    cores: cur.count,
    uptime: Math.round(os.uptime()),
    ts: Date.now()
  };
}

function startSysLoop() {
  sysTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const s = sampleSys();
    if (s) {
      sysHistory.push(s);
      if (sysHistory.length > 120) sysHistory.shift();
      lastSys = s;
      win.webContents.send('pet:sys', s);
    }
  }, 700);   // 700ms 一帧，机箱面板上的曲线/数字才是“实时”的
}

/* ---------- 光标轮询（60Hz） ---------- */
function startCursorLoop() {
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    try {
      const p = screen.getCursorScreenPoint();
      const b = win.getBounds();
      win.webContents.send('pet:cursor', {
        x: p.x - b.x, y: p.y - b.y, sx: p.x, sy: p.y
      });
    } catch (e) { /* ignore */ }
  }, 16);
}

/* ---------- 游荡模式：只"看"，绝不动 ----------
   这里只调用 desktopCapturer 读取窗口标题（纯读取，没有任何副作用），
   不模拟点击、不发送按键、不调用任何会改变其他程序状态的接口。
   所以它从架构上就不具备"操作其他软件"的能力。 */
const PEEK_NEVER = [
  '防火墙', 'Windows 安全', '安全中心', '病毒和威胁', 'Defender', 'SmartScreen',
  '用户账户控制', 'UAC', '注册表', 'regedit', '组策略', 'BitLocker',
  '磁盘管理', '设备管理器', '系统配置', 'msconfig', '控制面板',
  '凭据', '密码', '支付', '付款', '银行', '转账', '钱包',
  '格式化', '卸载', 'Windows 更新', '任务管理器',
  // 终端里可能正在跑重要命令，也不去凑热闹
  '命令提示符', 'PowerShell', 'pwsh', 'cmd.exe', 'Terminal', '终端'
];

const PEEK_FRIEND = [
  { keys: ['蓝牙', 'Bluetooth'], lines: ['蓝牙还开着呢，耳机连上了吗？', '好像有人忘了关蓝牙。'] },
  { keys: ['微信', 'Weixin', 'WeChat'], lines: ['有人找你吗？我不看内容。', '消息好多呀。'] },
  { keys: ['QQ', '钉钉', '飞书', 'Slack', 'Teams'], lines: ['在忙工作呀。', '这个窗口我认得。'] },
  { keys: ['网易云', 'QQ音乐', 'Spotify', '音乐'], lines: ['在听歌呀，我不吵你。', '这首好听吗？'] },
  { keys: ['Chrome', 'Edge', 'Firefox', '浏览器'], lines: ['标签页是不是又开了一堆…', '又在网上逛呢。'] },
  { keys: ['VS Code', 'Visual Studio', 'IntelliJ', 'Cursor', '编辑器'], lines: ['在写代码呀，那我安静点。', '这个我熟。'] },
  { keys: ['Steam', 'Minecraft', '游戏'], lines: ['玩得开心点！', '这游戏看着不错。'] },
  { keys: ['下载', '迅雷', 'IDM'], lines: ['在下东西？我等等。', '网速还行。'] },
  { keys: ['邮件', 'Outlook', 'Foxmail'], lines: ['有邮件来了吗？', '又是工作邮件…'] }
];

let peekTimer = null;

function classifyWindow(title) {
  const t = String(title || '');
  if (!t) return null;
  for (const k of PEEK_NEVER) {
    if (t.indexOf(k) >= 0) return { kind: 'danger', title: t };
  }
  for (const g of PEEK_FRIEND) {
    for (const k of g.keys) {
      if (t.indexOf(k) >= 0) {
        return { kind: 'friend', title: t, line: g.lines[Math.floor(Math.random() * g.lines.length)] };
      }
    }
  }
  return null;
}

async function peekOnce() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    });
    const titles = [];
    for (const s of sources) {
      const n = String(s.name || '');
      if (!n || n.indexOf('小机器人') >= 0) continue;   // 跳过自己
      titles.push(n);
    }
    // 禁区优先：屏幕上只要出现敏感窗口，就先躲开，不做任何好奇行为
    if (process.env.PET_WANDER_LOG) {
      console.log('[peek] 看到 ' + titles.length + ' 个窗口: ' + titles.slice(0, 6).join(' / '));
    }
    for (const t of titles) {
      const hit = classifyWindow(t);
      if (hit && hit.kind === 'danger') return hit;
    }
    const friends = [];
    for (const t of titles) {
      const hit = classifyWindow(t);
      if (hit && hit.kind === 'friend') friends.push(hit);
    }
    if (!friends.length) return null;
    return friends[Math.floor(Math.random() * friends.length)];
  } catch (err) {
    return null;
  }
}

function startPeekLoop() {
  if (peekTimer) return;
  let first = true;
  peekTimer = setInterval(async () => {
    if (first) { first = false; return; }          // 刚启动先别急着东张西望
    if (!settings.wander) return;
    if (manualHidden || fsHidden) return;
    if (!win || win.isDestroyed()) return;
    const hit = await peekOnce();
    if (process.env.PET_WANDER_LOG) {
      console.log('[peek] ' + (hit ? hit.kind + ' | ' + hit.title : 'none'));
    }
    if (hit && win && !win.isDestroyed()) {
      win.webContents.send('pet:peek', { kind: hit.kind, line: hit.line || '', title: hit.title });
    }
  }, 20000);
}

function setWander(on) {
  settings.wander = !!on;
  saveSettings();
  if (win && !win.isDestroyed()) win.webContents.send('pet:wander', settings.wander);
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/* ---------- 学习模式：检测到猿编程就自动变身 ----------
   和游荡模式同一套只读窗口标题的机制（desktopCapturer，纯读取无副作用）。
   看到猿编程窗口 → 换上「专注皮肤」说一句加油话；
   猿编程窗口消失 → 还原用户之前选的皮肤。可右键关闭。 */
const STUDY_KEYS = ['猿编程学生端', '学生端', 'AI IDE', 'ybc', 'YBC'];
// 标题是磁盘路径（C:\...）的是文件夹窗口，不算「在用猿编程」，
// 否则桌面常开的「猿编程课堂截图」之类的文件夹会一直触发学习模式
const STUDY_PATH_TITLE = /^[A-Za-z]:[\\/]/;
const STUDY_SKIN = 'deepsea';
const STUDY_LINES_ENTER = [
  '检测到猿编程，学习模式启动！我陪你一起写代码。',
  '要开始写代码了吗？我变个专注的样子陪你。',
  '学习模式上线！写累了记得看看我。',
  '猿编程开着呢，我就在旁边，卡住了就喊我。'
];
const STUDY_LINES_EXIT = [
  '猿编程关掉了，辛苦啦！换回原来的样子。',
  '学习结束！休息一下吧，我陪你。',
  '下课啦？记得让眼睛休息一会儿。'
];
let studyTimer = null;
let studyActive = false;
let studyPrevSkin = '';

function setStudy(on) {
  settings.study = !!on;
  saveSettings();
  if (!on && studyActive) {
    studyActive = false;
    applySkinChoice(studyPrevSkin || 'robot');   // 关掉开关时立刻还原
  }
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function setStudyActive(on, quiet) {
  if (on === studyActive) return;
  studyActive = on;
  if (on) {
    studyPrevSkin = settings.skin || 'robot';
    // 首次检测到猿编程：解锁隐藏款「猿编程喵」并当场穿上！
    if (!settings.ybcUnlocked) {
      settings.ybcUnlocked = true;
      saveSettings();
      if (win && !win.isDestroyed()) win.webContents.send('pet:skin-unlock');
      applySkinChoice('ybc');
      if (!quiet && win && !win.isDestroyed()) {
        petSay('叮！隐藏款「猿编程喵」解锁！这是给你打开猿编程的奖励，以后学习模式它都陪你。');
      }
      return;
    }
    applySkinChoice(STUDY_SKIN);
    if (!quiet && win && !win.isDestroyed()) {
      petSay(STUDY_LINES_ENTER[Math.floor(Math.random() * STUDY_LINES_ENTER.length)]);
    }
  } else {
    applySkinChoice(studyPrevSkin || 'robot');
    if (!quiet && win && !win.isDestroyed()) {
      petSay(STUDY_LINES_EXIT[Math.floor(Math.random() * STUDY_LINES_EXIT.length)]);
    }
  }
}

function startStudyLoop() {
  if (studyTimer) return;
  const dbg = !!process.env.PET_STUDY_LOG;
  if (dbg) console.log('[study] 循环启动，每 15 秒检测一次');
  studyTimer = setInterval(async () => {
    try {
      if (!settings.study) { setStudyActive(false, true); return; }
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false
      });
      let found = false;
      for (const s of sources) {
        const n = String(s.name || '');
        if (!n || n.indexOf('小机器人') >= 0) continue;
        if (STUDY_PATH_TITLE.test(n)) continue;       // 文件夹窗口不算
        for (const k of STUDY_KEYS) {
          if (n.indexOf(k) >= 0) { found = true; if (dbg) console.log('[study] 命中窗口: ' + n); break; }
        }
        if (found) break;
      }
      // 隐身时静默切换（不打招呼），现身时正常打招呼
      setStudyActive(found, manualHidden || fsHidden);
      if (dbg) console.log('[study] tick: found=' + found + ' active=' + studyActive + ' skin=' + settings.skin);
    } catch (err) {
      if (dbg) console.log('[study] 异常: ' + (err && err.message));
    }
  }, 15000);
}

/* ---------- 互动应用：可勾选的应用白名单 ----------
   用户自己勾选「哪些应用出现时搭理我」，比如豆包悬浮窗、微信、网易云。
   判断方式只有一种：desktopCapturer 读窗口标题（纯读取，不截图内容、不模拟按键）。
   系统事件（蓝牙开关）靠只读的 Get-PnpDevice 状态探针，不改变任何系统设置。 */
const INTERACT_COOLDOWN = 8 * 60 * 1000;   // 同一个应用 8 分钟内只打一次招呼
let interactTimer = null;
let interactBtTimer = null;
let interactWin = null;
let interactPrev = new Set();
const interactLastAt = {};
let interactSnapshot = { ids: [], titles: [], at: 0 };
let btState = null;

function interactCfg() {
  if (!settings.interact || typeof settings.interact !== 'object') {
    settings.interact = { on: true, allow: {}, custom: [], greetBack: true, bt: false };
  }
  const s = settings.interact;
  if (!s.allow || typeof s.allow !== 'object') s.allow = {};
  if (!Array.isArray(s.custom)) s.custom = [];
  return s;
}

async function interactTitles() {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  });
  const out = [];
  for (const s of sources) {
    const n = String(s.name || '').trim();
    if (!n) continue;
    if (n.indexOf('小机器人') >= 0 || n.indexOf('互动应用') >= 0) continue;   // 跳过自己
    if (INTERACT_NEVER.some((k) => n.indexOf(k) >= 0)) continue;              // 安全禁区永不搭理
    out.push(n);
  }
  return out;
}

async function interactScan() {
  const cfg = interactCfg();
  const titles = await interactTitles();
  const matched = new Set();     // 允许互动且当前存在
  const running = new Set();     // 只是当前存在（用于面板展示）
  const hit = {};
  for (const app of INTERACT_APPS) {
    let onScreen = false;
    for (const t of titles) {
      if ((app.keys || []).some((k) => t.indexOf(k) >= 0)) { onScreen = true; hit[app.id] = t; break; }
    }
    if (!onScreen) continue;
    running.add(app.id);
    if (cfg.allow[app.id] === true) matched.add(app.id);
  }
  for (const cu of cfg.custom) {
    const keys = ((cu.keys && cu.keys.length) ? cu.keys : [cu.name]).filter(Boolean);
    for (const t of titles) {
      if (keys.some((k) => t.indexOf(k) >= 0)) {
        running.add('c:' + cu.id);
        if (cu.on !== false) { matched.add('c:' + cu.id); hit['c:' + cu.id] = t; }
        break;
      }
    }
  }
  return { titles, matched, running, hit };
}

function interactSay(lines) {
  if (!lines || !lines.length) return;
  if (!win || win.isDestroyed()) return;
  petSay(lines[Math.floor(Math.random() * lines.length)]);
}

function interactReact(id, entering, quiet) {
  const cfg = interactCfg();
  const key = id + (entering ? ':in' : ':out');
  const now = Date.now();
  if (interactLastAt[key] && now - interactLastAt[key] < INTERACT_COOLDOWN) return false;
  interactLastAt[key] = now;
  if (quiet) return true;                       // 隐身时不说话，但冷却照记
  if (id.indexOf('c:') === 0) {
    const cu = cfg.custom.find((c) => 'c:' + c.id === id);
    if (!cu) return false;
    petSay(entering ? (cu.line || ('「' + cu.name + '」打开了，我在旁边。')) : ('「' + cu.name + '」关掉了。'));
    return true;
  }
  const app = INTERACT_APPS.find((a) => a.id === id);
  if (!app) return false;
  interactSay(entering ? app.lines : app.bye);
  return true;
}

function interactTest(id) {
  if (!id) return;
  if (id === 'bt') {
    const ev = SYSTEM_EVENTS.find((e) => e.id === 'bt');
    if (ev) interactSay(btState === 'off' ? ev.linesOff : ev.linesOn);
    return;
  }
  if (id.indexOf('c:') === 0) {
    const cu = interactCfg().custom.find((c) => 'c:' + c.id === id);
    petSay(cu ? ('「' + cu.name + '」打开了，我看着呢。') : '这个应用还没配置。');
    return;
  }
  const app = INTERACT_APPS.find((a) => a.id === id);
  if (app) interactSay(app.lines);
}

function buildInteractState() {
  const cfg = interactCfg();
  const seen = new Set(interactSnapshot.ids || []);
  return {
    on: cfg.on !== false,
    greetBack: cfg.greetBack !== false,
    apps: INTERACT_APPS.map((a) => ({
      id: a.id,
      name: a.name,
      emoji: a.emoji,
      desc: a.desc || '',
      allow: cfg.allow[a.id] === true,
      running: seen.has(a.id)
    })),
    custom: cfg.custom.map((c) => ({
      id: c.id,
      name: c.name,
      keys: c.keys || [],
      on: c.on !== false,
      running: seen.has('c:' + c.id)
    })),
    system: SYSTEM_EVENTS.map((e) => ({
      id: e.id,
      name: e.name,
      emoji: e.emoji,
      desc: e.desc || '',
      allow: e.id === 'bt' ? !!cfg.bt : false,
      state: e.id === 'bt' ? btState : null
    }))
  };
}

function pushInteract() {
  if (interactWin && !interactWin.isDestroyed()) {
    interactWin.webContents.send('interact:state', buildInteractState());
  }
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function startInteractLoop() {
  if (interactTimer) return;
  const dbg = !!process.env.PET_INTERACT_LOG;
  if (dbg) console.log('[interact] 循环启动，每 12 秒读一次窗口标题');
  interactTimer = setInterval(async () => {
    let r;
    try { r = await interactScan(); } catch (err) { return; }
    const cfg = interactCfg();
    interactSnapshot = { ids: Array.from(r.running), titles: r.titles, at: Date.now() };
    if (interactWin && !interactWin.isDestroyed()) interactWin.webContents.send('interact:state', buildInteractState());
    if (cfg.on === false) { interactPrev = new Set(); return; }
    const quiet = manualHidden || fsHidden;
    for (const id of r.matched) {
      if (!interactPrev.has(id)) {
        interactReact(id, true, quiet);
        if (dbg) console.log('[interact] 出现 ' + id + ' ← ' + (r.hit[id] || ''));
      }
    }
    if (cfg.greetBack !== false) {
      for (const id of interactPrev) {
        if (!r.matched.has(id)) {
          interactReact(id, false, quiet);
          if (dbg) console.log('[interact] 离开 ' + id);
        }
      }
    }
    interactPrev = r.matched;
  }, 12000);
}

/* 蓝牙开关：只读 PnP 适配器状态（Get-PnpDevice 是查询，不改设置）。
   不同机型上报方式不一样，读不到就保持 unknown，不瞎报。 */
const BT_STATUS_SCRIPT = [
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  "$d = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'USB\\*' } | Select-Object -First 1",
  "if (-not $d) { $d = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'BTH\\MS_BTHBRB*' } | Select-Object -First 1 }",
  "if ($d) { $d.Status } else { 'none' }"
].join('\n');

async function btProbe() {
  const out = String(await execPowerShell(BT_STATUS_SCRIPT, 8000)).trim();
  if (!out || /^none$/i.test(out)) return 'unknown';
  return /^ok$/i.test(out) ? 'on' : 'off';
}

function startBtLoop() {
  if (interactBtTimer) return;
  interactBtTimer = setInterval(async () => {
    const cfg = interactCfg();
    if (!cfg.bt) return;
    const st = await btProbe();
    if (st === 'unknown') return;
    const changed = btState && st !== btState;
    btState = st;
    if (changed && cfg.on !== false && !(manualHidden || fsHidden)) {
      const ev = SYSTEM_EVENTS.find((e) => e.id === 'bt');
      if (ev) interactSay(st === 'on' ? ev.linesOn : ev.linesOff);
    }
    if (changed && interactWin && !interactWin.isDestroyed()) {
      interactWin.webContents.send('interact:state', buildInteractState());
    }
  }, 45000);
}

function openInteractPanel() {
  interactCfg();
  if (interactWin && !interactWin.isDestroyed()) {
    interactWin.show();
    interactWin.focus();
    interactWin.webContents.send('interact:state', buildInteractState());
    return;
  }
  interactWin = new BrowserWindow({
    width: 640,
    height: 780,
    minWidth: 540,
    minHeight: 520,
    frame: false,
    backgroundColor: '#121020',
    title: '互动应用',
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'interact-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  interactWin.loadFile(path.join(__dirname, 'interact.html'));
  interactWin.once('ready-to-show', () => {
    if (!interactWin || interactWin.isDestroyed()) return;
    interactWin.show();
    interactWin.webContents.send('interact:state', buildInteractState());
    // 打开面板时立刻扫一次，列表里马上能看到"正在运行"
    interactScan().then((r) => {
      interactSnapshot = { ids: Array.from(r.running), titles: r.titles, at: Date.now() };
      if (interactWin && !interactWin.isDestroyed()) interactWin.webContents.send('interact:state', buildInteractState());
    }).catch(() => {});
    btProbe().then((st) => {
      if (st !== 'unknown') btState = st;
      if (interactWin && !interactWin.isDestroyed()) interactWin.webContents.send('interact:state', buildInteractState());
    }).catch(() => {});
  });
  interactWin.on('closed', () => { interactWin = null; });
}

/* ---------- 联动：状态缓存到本地，重启后先显示上次的数字 ---------- */
function loadLinkCache() {
  try {
    stateFile = path.join(app.getPath('userData'), 'link-state.json');
    if (fs.existsSync(stateFile)) {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (raw && raw.state) link.state = raw.state;
      const cached = appUrl(raw && raw.appUrl);
      if (cached) {
        link.appUrl = cached;
      } else {
        link.appUrl = DEFAULT_APP_URL;
        saveLinkCache();                     // 顺手把坏地址洗掉
      }
    }
  } catch (err) { /* 缓存坏了不影响启动 */ }
}

function saveLinkCache() {
  try {
    if (!stateFile) return;
    fs.writeFileSync(stateFile, JSON.stringify({
      state: link.state, appUrl: link.appUrl, ts: Date.now()
    }));
  } catch (err) { /* ignore */ }
}

function broadcastLink() {
  if (win && !win.isDestroyed()) win.webContents.send('pet:link', link);
  if (tray) {
    const s = link.state || {};
    const bits = [];
    if (link.online) {
      if (s.todos) bits.push(s.todos + ' 件待办');
      if (s.overdue) bits.push(s.overdue + ' 件逾期');
      tray.setToolTip('3D 小机器人 · ' + (bits.length ? bits.join('，') : '信息管家已连接'));
    } else {
      tray.setToolTip('3D 小机器人 · 信息管家未连接');
    }
  }
}

function openApp(cmd) {
  const online = bridge && bridge.isOnline();
  if (online) {
    bridge.push(cmd || 'focus');
    showWindow();
    return;
  }
  // 网页没开：直接把信息管家打开
  const url = appUrl(bridge && bridge.getAppUrl()) || appUrl(link.appUrl) || DEFAULT_APP_URL;
  try { shell.openExternal(url); } catch (err) { /* ignore */ }
}

/* ---------- 联动：接收网页推送的状态 ---------- */
let menuKey = '';

function handleLinkState(payload) {
  const prev = link;
  link = {
    online: !!payload.online,
    state: payload.state || prev.state,
    appUrl: appUrl(payload.appUrl) || prev.appUrl
  };

  const s = link.state || {};
  const key = [link.online, s.todos, s.overdue, s.today].join('|');
  if (key !== menuKey) {
    menuKey = key;
    if (tray) tray.setContextMenu(buildTrayMenu());
  }

  if (payload.online) saveLinkCache();

  // 网页回执：这几条已经落库了，从待同步队列里划掉
  if (payload.acked && payload.acked.length && outbox) {
    const n = outbox.ack(payload.acked);
    if (n) petSay(n === 1 ? '已经归到管家收件箱了。' : ('刚记的 ' + n + ' 条都已入库。'));
  }

  // 网页刚连上（或一直在线）：把攒着的桌面记录灌进去，顺便补上没分析的陪看会话
  if (payload.online) {
    setTimeout(flushOutbox, payload.changed ? 400 : 0);
    setTimeout(flushWatchPending, payload.changed ? 900 : 300);
  }

  broadcastLink();
}

/* ---------- 陪看模式 ----------
   发现「标题像视频页」的 B 站窗口就自动采帧，看完把截图交给管家的 AI 出观点，
   再生成一份 PPT 报告落到 D 盘。Ctrl+Alt+B 或托盘可随时关。 */
let watchTimer = null;
let watcher = null;
let lastWatchDir = '';
const pendingWatch = {};       // sid -> 会话（等网页分析结果回来出报告）
const reportingWatch = {};     // sid -> 正在出报告（这段时间别重复送分析，白烧 token）
const watchAckTimers = {};     // sid -> 「等回音」的超时计时器
const WATCH_ACK_MS = 150000;   // 送出去最多等 2.5 分钟；等不到就重来（网页可能根本没开）

/** 报告放哪：优先 D 盘；盘符不存在（换机器 / 拔了移动硬盘）就退回桌面，绝不因此写不出文件 */
function reportRoot() {
  // 想换到别的盘就设 PET_REPORT_ROOT（也方便测试）
  const custom = process.env.PET_REPORT_ROOT;
  if (custom) return custom;
  try {
    if (fs.existsSync('D:\\')) return 'D:\\';
  } catch (e) { /* 忽略 */ }
  return app.getPath('desktop');
}

/** 报告固定落这里，跟「有没有生成过」无关 —— 没生成过也能打开看看 */
function reportDir() {
  return path.join(reportRoot(), '陪看报告');
}

/** 说人话的位置描述，跟着实际盘符走 */
function reportWhere() {
  const root = reportRoot().replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(root)) return root.slice(0, 1).toUpperCase() + ' 盘的「陪看报告」';
  try {
    if (root === app.getPath('desktop').replace(/[\\/]+$/, '')) return '桌面的「陪看报告」';
  } catch (e) { /* 忽略 */ }
  return '「' + root + '」里的陪看报告';
}

/** 数一下已经生成了几份报告（一份 = 一个 pptx） */
function reportCount(dir) {
  const d = dir || reportDir();
  try {
    return fs.readdirSync(d).filter((n) => /\.pptx$/i.test(n)).length;
  } catch (e) {
    return 0;
  }
}

/**
 * 打开陪看报告。文件夹不存在就建出来；
 * 一份都还没有的话，顺手说一句，别让用户对着一片空白发愣。
 */
function openWatchReports() {
  const dir = reportDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 忽略 */ }
  const n = reportCount(dir);
  lastWatchDir = dir;
  try {
    const err = shell.openPath(dir);
    if (err && typeof err.then === 'function') err.catch(() => {});
  } catch (e) { /* 忽略 */ }
  if (!n) petSay('还没生成过报告，看完一个 B 站视频就有了。');
  else petSay('报告在' + reportWhere() + '里，一共 ' + n + ' 份。');
}

/** 菜单项文案：没报告也能点，别灰着 */
function watchReportItem() {
  const n = reportCount();
  return {
    label: n ? '打开陪看报告（' + n + ' 份）' : '打开陪看报告文件夹',
    click: () => openWatchReports()
  };
}

/** 最新一份报告（按修改时间，双击就能打开） */
function latestReportFile() {
  const dir = reportDir();
  try {
    const files = fs.readdirSync(dir)
      .filter((n) => /\.pptx$/i.test(n))
      .map((n) => {
        const p = path.join(dir, n);
        let t = 0;
        try { t = fs.statSync(p).mtimeMs; } catch (e) { /* 忽略 */ }
        return { p, t };
      })
      .sort((a, b) => b.t - a.t);
    return files[0] ? files[0].p : '';
  } catch (e) {
    return '';
  }
}

/** 「打开最新报告」：一键直达，不用先进文件夹翻 */
function openLatestReport() {
  const file = latestReportFile();
  if (!file) {
    petSay('还没有报告，看完一个 B 站视频我就给你做一份。');
    openWatchReports();
    return;
  }
  try { shell.openPath(file); } catch (e) { /* 忽略 */ }
  petSay('给你打开最近这份：' + path.basename(file).replace(/\.[a-z0-9]+$/i, ''));
}

/** 菜单项：有报告才可点，标题直接写进菜单，不用点开才知道是哪一份 */
function latestReportItem() {
  const file = latestReportFile();
  let label = '打开最新一份报告（还没有）';
  if (file) {
    const name = path.basename(file).replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.pptx$/i, '');
    label = '打开最新报告：' + (name.length > 14 ? name.slice(0, 14) + '…' : name);
  }
  return {
    label,
    enabled: !!file,
    click: () => openLatestReport()
  };
}

/* ---------- 报告占了多少地方 / 一键清理 ---------- */

function fmtBytes(b) {
  const v = Number(b) || 0;
  if (v >= 1024 * 1024 * 1024) return (v / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

/** 报告目录的份数和体积（按 pptx 算，一份 = 一个文件） */
function reportStats() {
  const dir = reportDir();
  let count = 0;
  let bytes = 0;
  try {
    fs.readdirSync(dir).filter((n) => /\.pptx$/i.test(n)).forEach((n) => {
      count += 1;
      try { bytes += fs.statSync(path.join(dir, n)).size; } catch (e) { /* 忽略 */ }
    });
  } catch (e) { /* 目录还不存在 */ }
  return { count, bytes };
}

/** 报告列表：新的在前 */
function reportFiles() {
  const dir = reportDir();
  try {
    return fs.readdirSync(dir)
      .filter((n) => /\.pptx$/i.test(n))
      .map((n) => {
        const p = path.join(dir, n);
        let t = 0;
        try { t = fs.statSync(p).mtimeMs; } catch (e) { /* 忽略 */ }
        return { p, t };
      })
      .sort((a, b) => b.t - a.t);
  } catch (e) {
    return [];
  }
}

/**
 * 一键清理：看几个视频试功能留下的报告，手动去文件夹删太麻烦。
 * 一律走回收站（shell.trashItem），万一删错了还能捞回来；不硬删。
 */
async function cleanReports() {
  const st = reportStats();
  if (!st.count) {
    petSay('报告文件夹本来就是空的，不用清。');
    return;
  }
  let choice = 2;
  try {
    const r = await dialog.showMessageBox({
      type: 'question',
      buttons: ['只留最近 3 份', '全部清掉', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: '清理陪看报告',
      message: '现在有 ' + st.count + ' 份报告，占 ' + fmtBytes(st.bytes) + '。',
      detail: '删掉的文件会进回收站，误删还能捞回来。'
    });
    choice = r && typeof r.response === 'number' ? r.response : 2;
  } catch (e) {
    return;
  }
  if (choice === 2) return;

  const keep = choice === 0 ? 3 : 0;
  const drop = reportFiles().slice(keep);
  let done = 0;
  for (const f of drop) {
    try {
      await shell.trashItem(f.p);
      done += 1;
    } catch (e) { /* 单个失败不影响其它 */ }
  }
  if (tray) tray.setContextMenu(buildTrayMenu());
  refreshTrayTip();
  if (!done) petSay('一份都没删掉，可能被别的程序占着。');
  else petSay('清掉了 ' + done + ' 份报告（在回收站里），剩下的还在' + reportWhere() + '。');
}

/** 菜单项：直接显示「几份 · 多大」，嫌占地方的时候一眼就知道要不要清 */
function reportCleanItem() {
  const st = reportStats();
  return {
    label: st.count ? '清理陪看报告（' + st.count + ' 份 · ' + fmtBytes(st.bytes) + '）' : '清理陪看报告（空的）',
    enabled: st.count > 0,
    click: () => { cleanReports().catch(() => {}); }
  };
}

/* ---------- 一键清空缓存（给小机器人降火） ----------
   变红的根源是 CPU/内存，能安全清掉的是「自己攒的垃圾」：
   已分析过的录像、7 天前的 Windows 临时文件。
   不碰：笔记、设置、皮肤、陪看报告，以及任何个人文件。 */

function dirBytes(dir) {
  let total = 0;
  try {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) total += dirBytes(p);
      else total += st.size;
    }
  } catch (e) { /* 读不动就算了 */ }
  return total;
}

const TEMP_DAYS = 7;

/** 临时文件根目录（测试时可用 PET_TEMP_DIR 指到沙箱，绝不碰真系统临时目录） */
function tempRoot() {
  const p = process.env.PET_TEMP_DIR;
  return p && p.trim() ? p : os.tmpdir();
}

/** 陪看录像里哪些能删：已经分析过（session.sent.json）或只剩图的；
 *  有 session.json 的说明还在等分析，绝对不能删（删了就白看了）。 */
function watchCacheStats() {
  const root = watchRoot();
  let sessions = 0;
  let bytes = 0;
  let keep = 0;
  try {
    for (const n of fs.readdirSync(root)) {
      if (!/^w[0-9a-z]+$/.test(n)) continue;
      const p = path.join(root, n);
      const pending = fs.existsSync(path.join(p, 'session.json'));
      if (pending) { keep += 1; continue; }
      sessions += 1;
      bytes += dirBytes(p);
    }
  } catch (e) { /* 目录不存在 */ }
  return { sessions, bytes, keep, root };
}

function tempCacheStats() {
  const dir = tempRoot();
  const cut = Date.now() - TEMP_DAYS * 86400000;
  let count = 0;
  let bytes = 0;
  try {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.mtimeMs > cut) continue;
      count += 1;
      bytes += st.isDirectory() ? dirBytes(p) : st.size;
    }
  } catch (e) { /* 忽略 */ }
  return { count, bytes, dir };
}

/** 菜单项文案：直接写清能清多少，不用点开才知道 */
function cacheCleanItem() {
  const w = watchCacheStats();
  const t = tempCacheStats();
  const total = w.bytes + t.bytes;
  const label = total > 1024
    ? '一键清空缓存（可清 ' + fmtBytes(total) + '）'
    : '一键清空缓存（已经很干净）';
  return { label, click: () => { cleanCaches().catch(() => {}); } };
}

async function cleanCaches() {
  const w = watchCacheStats();
  const t = tempCacheStats();
  if (!w.sessions && !t.count) {
    petSay('缓存挺干净的，没什么可清。变红多半是别的程序在忙，右键看看「谁在吃 CPU」。');
    return;
  }
  const s = lastSys || {};
  const load = (typeof s.cpu === 'number') ? '现在 CPU ' + s.cpu + '%、内存 ' + s.mem + '%。' : '';
  let choice = 1;
  try {
    const r = await dialog.showMessageBox({
      type: 'question',
      buttons: ['开始清理', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: '一键清空缓存',
      message: load + '可以安全清掉这些：',
      detail: [
        '· 过期的陪看录像：' + w.sessions + ' 场 · ' + fmtBytes(w.bytes) + '（已经分析过的）',
        '· Windows 临时文件：' + t.count + ' 个 · ' + fmtBytes(t.bytes) + '（' + TEMP_DAYS + ' 天前的，正在用的会跳过）',
        w.keep ? '' : '',
        w.keep ? '· 还有 ' + w.keep + ' 场录像在等分析，这些会留着' : '',
        '',
        '不会动：笔记、设置、皮肤、陪看报告，以及任何个人文件。'
      ].filter((x) => x !== '').join('\n')
    });
    choice = r && typeof r.response === 'number' ? r.response : 1;
  } catch (e) {
    return;
  }
  if (choice !== 0) return;

  petSay('开始清…');
  let freed = 0;
  let failed = 0;

  // 1) 过期录像
  try {
    for (const n of fs.readdirSync(w.root)) {
      if (!/^w[0-9a-z]+$/.test(n)) continue;
      const p = path.join(w.root, n);
      if (fs.existsSync(path.join(p, 'session.json'))) continue;      // 等分析的不动
      const before = dirBytes(p);
      try { fs.rmSync(p, { recursive: true, force: true }); freed += before; }
      catch (e) { failed += 1; }
    }
  } catch (e) { /* 忽略 */ }

  // 2) 老临时文件（逐个删，占用中的跳过）
  const cut = Date.now() - TEMP_DAYS * 86400000;
  try {
    for (const n of fs.readdirSync(t.dir)) {
      const p = path.join(t.dir, n);
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.mtimeMs > cut) continue;
      const before = st.isDirectory() ? dirBytes(p) : st.size;
      try { fs.rmSync(p, { recursive: true, force: true }); freed += before; }
      catch (e) { failed += 1; }
    }
  } catch (e) { /* 忽略 */ }

  refreshTrayTip();
  if (tray) tray.setContextMenu(buildTrayMenu());
  petSay(freed > 0
    ? '清完了，腾出 ' + fmtBytes(freed) + (failed ? '（' + failed + ' 个正被占用，跳过了）' : '') + '。'
    : '没清出空间来，这些文件可能正被别的程序用着。');
}

/* ---------- 谁在吃电脑（变红了看一眼就知道该关谁） ---------- */

function execPowerShell(script, timeout) {
  return new Promise((resolve) => {
    let execFile;
    try { execFile = require('child_process').execFile; } catch (e) { return resolve(''); }
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
      { timeout: timeout || 8000, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

async function topProcesses(limit) {
  const n = limit || 6;
  // 不用 WMI 性能计数器（某些机器 Win32_PerfFormattedData_PerfProc_Process 直接是「无效类」），
  // 改成两次 Get-Process 的 CPU 时间差分：哪都能跑，0.8 秒出结果。
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    '$cores=[Environment]::ProcessorCount',
    '$a=@{}',
    'Get-Process | Where-Object { $_.CPU -ne $null } | ForEach-Object { $a[$_.Id]=$_.CPU }',
    'Start-Sleep -Milliseconds 800',
    'Get-Process | Where-Object { $a.ContainsKey($_.Id) } | ForEach-Object {',
    '  $d=$_.CPU - $a[$_.Id]',
    '  if ($d -gt 0) { $_.ProcessName + "|" + [math]::Round($d/0.8/$cores*100) + "|" + [math]::Round($_.WorkingSet64/1MB) }',
    '}'
  ].join('\n');
  const out = await execPowerShell(script, 9000);
  const merged = new Map();
  out.trim().split(/\r?\n/).forEach((l) => {
    const p = l.trim().split('|');
    if (p.length < 3) return;
    const name = p[0];
    const cpu = Number(p[1]) || 0;
    const mb = Number(p[2]) || 0;
    const cur = merged.get(name) || { name, cpu: 0, mb: 0 };
    cur.cpu += cpu;
    cur.mb += mb;
    merged.set(name, cur);
  });
  return Array.from(merged.values()).sort((a, b) => b.cpu - a.cpu).slice(0, n);
}

async function showTopProcesses() {
  const s = lastSys || {};
  const load = (typeof s.cpu === 'number') ? '现在 CPU ' + s.cpu + '%、内存 ' + s.mem + '%。' : '';
  const top = await topProcesses(6);
  if (!top.length) {
    petSay('拿不到进程列表，我直接帮你开任务管理器吧。');
    try { require('child_process').spawn('taskmgr.exe', [], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { /* 忽略 */ }
    return;
  }
  const lines = top.map((p, i) => (i + 1) + '. ' + p.name + '　CPU ' + p.cpu + '%　内存 ' + p.mb + ' MB');
  let r = null;
  try {
    r = await dialog.showMessageBox({
      type: 'info',
      buttons: ['打开任务管理器', '知道了'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: '谁在吃 CPU / 内存',
      message: load + '最忙的几个：',
      detail: lines.join('\n') + '\n\n想关谁就在任务管理器里结束它；不确定的就别动，系统进程关不得。'
    });
  } catch (e) {
    return;
  }
  if (r && r.response === 0) {
    try { require('child_process').spawn('taskmgr.exe', [], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { /* 忽略 */ }
  }
}

function onWatchEvent(ev, payload) {
  if (ev === 'start') {
    petSay('陪你看《' + payload.title + '》，看完我给你个说法。');
    refreshTrayTip();
  } else if (ev === 'end') {
    refreshTrayTip();
    petSay('看完了《' + payload.title + '》，记了 ' + payload.frames.length + ' 帧，我整理一下出报告。');
    enqueueWatch(payload);
  } else if (ev === 'discard') {
    // 太短的场次不打扰用户，但日志里要留痕，排查“怎么没报告”时用得上
    console.log('[watch] 场次太短不生成报告（' + (payload.frames ? payload.frames.length : 0) + ' 帧）：' + payload.title);
  }
}

/** 托盘悬停提示：看一眼就知道它现在在陪看什么 */
function refreshTrayTip() {
  if (!tray) return;
  const st = watcher && watcher.status();
  try {
    tray.setToolTip(st ? '正在陪看：' + st.title + '（已记 ' + st.frames + ' 帧）' : '3D 小机器人 · 待命');
  } catch (e) { /* 忽略 */ }
}

/** 去 B 站把标题对成视频，拿详情和弹幕 —— 失败就算了，还能靠截图 */
async function enrichBili(title) {
  try {
    const got = await Promise.race([
      bili.enrich(title, { danmaku: true, maxSamples: 40 }),
      new Promise((r) => setTimeout(() => r(null), 12000))
    ]);
    return got;
  } catch (e) {
    return null;
  }
}

async function enqueueWatch(session) {
  session.bili = await enrichBili(session.title);
  if (session.bili && session.bili.ok) {
    session.bvid = session.bili.bvid;
    const b = session.bili;
    const dm = b.danmaku && b.danmaku.total;
    // 认出来了就报个「证据」，让它看起来真是看过而不是瞎猜
    petSay('认出来了，UP 主是' + (b.info.owner || '谁不知道') + (dm ? '，这场有 ' + dm + ' 条弹幕' : '') + '，我照着这些说观点。');
  }
  sendWatchForAnalysis(session);
}

const MAX_AI_FRAMES = 12;                  // 一次最多送几张给模型（再多也没用，纯烧 token）
const MAX_AI_BYTES = 6 * 1024 * 1024;      // base64 总量上限，超了就少送几张

function pickEven(list, n) {
  if (list.length <= n) return list;
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.round((i * (list.length - 1)) / (n - 1))]);
  return out;
}

function watchRoot() {
  return path.join(app.getPath('userData'), 'watch');
}

/** 内存里的帧直接有 base64；从磁盘补发的会话只有文件路径，这里现压一张出来 */
function frameBase64(f) {
  if (f.ai) return f.ai;
  try {
    const img = nativeImage.createFromPath(f.file);
    if (!img || img.isEmpty()) return '';
    return img.resize({ width: 720, quality: 'good' }).toJPEG(58).toString('base64');
  } catch (e) {
    return '';
  }
}

/**
 * 分析这一步是在管家的网页里调云端大模型做的，桌面端自己算不了。
 * 所以网页没开着的时候，光攒素材是永远出不来报告的 ——
 * 这里干脆把管家打开（十分钟最多开一次，别老抢焦点）。
 */
let lastAutoOpenAt = 0;
function ensureHubForAnalysis() {
  if (bridge && bridge.isOnline()) return true;
  const now = Date.now();
  if (now - lastAutoOpenAt < 10 * 60000) return false;
  lastAutoOpenAt = now;
  petSay('报告得靠管家里的 AI 来写，我把管家打开，它一连上我就把这几场补上。');
  setTimeout(() => { try { openApp('focus'); } catch (e) { /* 忽略 */ } }, 600);
  return false;
}

/**
 * 送出去之后盯一段时间。
 * 关键：以前这里是「发出去就改名成 sent」，网页要是没开着，这场就永久判死——
 * 用户看了两轮视频，磁盘上躺着 7 场录像、一条报告都没有，就是这么来的。
 * 现在改成「等回音」：等不到就还回去重试，试满 MAX_TRIES 次才认命（素材不删，能手动重来）。
 */
/** 放弃自动重试（只留素材），带一行日志，方便日后查「为什么这场没出报告」 */
function giveUpWatch(id, why) {
  console.log('[watch] 放弃自动重试 ' + id + '：' + why);
  markSessionSent(watchRoot(), id);
}

function armWatchAck(session) {
  clearTimeout(watchAckTimers[session.id]);
  watchAckTimers[session.id] = setTimeout(() => {
    delete watchAckTimers[session.id];
    if (!pendingWatch[session.id]) return;              // 结果已经回来了
    delete pendingWatch[session.id];
    const tries = noteSessionAttempt(watchRoot(), session.id);
    console.log('[watch] ' + session.id + ' 等回音超时，第 ' + tries + ' 次');
    if (tries >= MAX_TRIES) {
      giveUpWatch(session.id, '试了 ' + tries + ' 次没回音');
      petSay('《' + (session.title || '这个视频') + '》试了 ' + tries + ' 次都没等到管家回话，素材我先收着，你点一下陪看就能再试。');
      return;
    }
    petSay('这次分析没等到回音，我再试一次。');
    setTimeout(flushWatchPending, 900);
  }, WATCH_ACK_MS);
}

/**
 * 把一场看完的视频送去分析。
 * 发得出去就发；发不出去就留在 pendingWatch（内存）里，磁盘上那份 session.json 也没动，
 * 管家一上线 / 程序下次启动都会自动补上。
 */
function sendWatchForAnalysis(session, opts) {
  const o = opts || {};
  if (!bridge || !bridge.isOnline()) {
    const ids = Object.keys(pendingWatch);
    if (ids.length >= 4) delete pendingWatch[ids[0]];
    pendingWatch[session.id] = session;
    if (!o.silent) ensureHubForAnalysis();
    return false;
  }
  // 认出了 B 站视频就以文字为主（准），认不出就多给几张截图（瞎猜也比没有强）
  const hasBili = !!(session.bili && session.bili.ok);
  const biliText = hasBili ? bili.toPromptText(session.bili) : '';
  const frameCap = hasBili ? 6 : MAX_AI_FRAMES;

  const picked = pickEven(session.frames.filter((f) => frameBase64(f)), frameCap);
  const frames = [];
  let bytes = 0;
  picked.forEach((f) => {
    const ai = frameBase64(f);
    if (!ai) return;
    const data = 'data:image/jpeg;base64,' + ai;
    if (bytes + data.length > MAX_AI_BYTES) return;
    bytes += data.length;
    frames.push({ i: f.i, data });
  });
  pendingWatch[session.id] = session;
  armWatchAck(session);                              // 等回音；等不到会自动重来
  const minutes = Math.max(1, Math.round(((session.endedAt || Date.now()) - session.startedAt) / 60000));
  console.log('[watch] 送分析 ' + session.id + ' ' + session.frames.length + ' 帧 → ' + frames.length + ' 张，B站=' + (hasBili ? session.bvid : '没认出来'));
  bridge.push({
    cmd: 'watch-analyze',
    sid: session.id,
    title: session.title,
    frames,
    minutes,
    bvid: session.bvid || '',
    bili: biliText
  });
  if (!o.silent) petSay('看完了，正翻着画面想观点……');
  return true;
}

/**
 * 补发攒下的陪看会话。
 * 以前这里是个坑：管家没开时只攒在内存里、永远不补发，程序一关就彻底丢了。
 * 现在不管「刚连上」还是「重开程序」，都把磁盘上没发过的捞出来补上。
 */
let flushingWatch = false;
async function flushWatchPending() {
  if (flushingWatch || !bridge || !bridge.isOnline()) return 0;
  flushingWatch = true;
  let sent = 0;
  try {
    // 正在等回音 / 正在出报告的别重复发；试满次数的别再来（留着素材给用户手动重试）
    const pending = listPendingSessions(watchRoot())
      .filter((m) => !pendingWatch[m.id] && !reportingWatch[m.id] && (m.attempts || 0) < MAX_TRIES)
      .slice(0, 2);                                                 // 一次最多补 2 场，别一口气怼上去
    for (const meta of pending) {
      if (!meta.bili) meta.bili = await enrichBili(meta.title);     // 补发时也去 B 站认一下
      if (meta.bili && meta.bili.ok) meta.bvid = meta.bili.bvid;
      if (!bridge.isOnline()) break;
      if (sendWatchForAnalysis(meta, { silent: true })) sent += 1;
    }
    if (sent) petSay('补上之前看的那 ' + sent + ' 个视频，正在翻画面。');
  } catch (err) {
    /* 补发失败就算了，下次连上再试 */
  }
  flushingWatch = false;
  return sent;
}

/** 托盘气泡：用户可能没盯着小机器人，报告好了要说一声 */
function notifyDone(title, content) {
  try {
    if (tray && tray.displayBalloon) tray.displayBalloon({ title, content, iconType: 'info' });
  } catch (e) { /* 系统禁了通知就算了，气泡里还会说 */ }
}

/** 结果回来时内存里可能没有这场了（程序刚重启过），从磁盘捞一把，别让报告白算 */
function loadSessionMeta(id) {
  const dir = path.join(watchRoot(), id);
  for (const name of ['session.json', 'session.sent.json']) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (meta && Array.isArray(meta.frames)) { meta.dir = dir; return meta; }
    } catch (e) { /* 换下一个 */ }
  }
  return null;
}

function handleWatchResult(w) {
  const session = pendingWatch[w.sid] || loadSessionMeta(w.sid);
  clearTimeout(watchAckTimers[w.sid]);
  delete watchAckTimers[w.sid];
  delete pendingWatch[w.sid];
  console.log('[watch] 收到分析结果 ' + w.sid + (w.result ? '（有内容）' : '（空的）'));
  if (!session) return;
  if (!w.result) {
    const tries = noteSessionAttempt(watchRoot(), w.sid);
    if (tries >= MAX_TRIES) {
      giveUpWatch(w.sid, '分析返回空，已试 ' + tries + ' 次');
      petSay('《' + (session.title || '这个视频') + '》这次确实没分析成，素材我留着，你点一下陪看可以再试。');
      return;
    }
    petSay('这个视频这次没分析成，我过一会儿再试一次。');
    setTimeout(flushWatchPending, 2000);      // 队列里还有别的就继续
    return;
  }

  const outDir = reportDir();
  reportingWatch[w.sid] = true;                       // 出报告期间别再重复送这场
  buildReport(session, w.result, outDir).then((files) => {
    lastWatchDir = outDir;
    const where = reportWhere();
    if (files.pptx) {
      // 明确告诉用户「分析完了 + 东西在哪」——之前只说结果，用户根本没注意到
      const sc = Number(w.result && w.result.rating);
      const scoreBit = isFinite(sc) && sc > 0 ? '我给它 ' + sc.toFixed(1) + ' 分，' : '';
      petSay('《' + (session.title || '这个视频') + '》分析完了！' + scoreBit + 'PPT 报告已经放到' + where + '，Ctrl+Alt+L 直接打开。');
      notifyDone('陪看报告好了', '《' + (session.title || 'B 站视频') + '》的观点已存到 ' + where);
      dropSession(watchRoot(), session.id);
      setTimeout(flushWatchPending, 1500);    // 队列里还有别的就继续
    } else {
      petSay('报告没生成出来，本地素材还留着，再点一次陪看可以重试。');
    }
    delete reportingWatch[w.sid];
    if (tray) tray.setContextMenu(buildTrayMenu());
  }).catch((err) => {
    delete reportingWatch[w.sid];
    petSay('报告生成失败：' + (err.message || '未知错误'));
  });
}

function startWatchLoop() {
  // 老版本只存了 jpg 没存元数据，这些录像一直没人分析 —— 先认领回来（最多 3 场）
  try {
    const adopted = adoptLegacySessions(watchRoot(), 3);
    if (adopted) console.log('[watch] 认领了 ' + adopted + ' 场旧录像，等管家上线补分析');
  } catch (e) { /* 忽略 */ }
  // 还有一种：录到一半被关机/断电 —— 元数据是逐帧落盘的，这里把它们的 recording 收尾，
  // 重启后照样能出报告（标题不会丢）
  try {
    const pending = listPendingSessions(watchRoot(), { includeOrphans: true });
    const orphans = pending.filter((m) => m.reason === 'orphan');
    if (orphans.length) console.log('[watch] 认领了 ' + orphans.length + ' 场「录到一半被关机」的录像，重启后补分析');
  } catch (e) { /* 忽略 */ }
  try {
    watcher = createWatcher({
      // 两段式：不采样的拍子只要窗口名（thumbnailSize 0x0 = 不让系统生成任何位图）；
      // 真到采样点才按 960x540 抓一次。这样挂在后台时基本不占 CPU/内存。
      capture: async (o) => {
        const wantThumbs = !!(o && o.thumbnails);
        const sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: wantThumbs ? { width: 960, height: 540 } : { width: 0, height: 0 },
          fetchWindowIcons: false
        });
        return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail }));
      },
      dir: watchRoot(),
      onEvent: onWatchEvent
    });
  } catch (err) {
    watcher = null;
    console.log('[watch] init failed:', err.message);
    return;
  }
  watchTimer = setInterval(() => {
    if (!settings.watchMode || !watcher) return;
    watcher.tick().then(() => refreshTrayTip()).catch(() => { /* 单次轮询失败不算什么 */ });
  }, 3000);
}

function toggleWatch() {
  settings.watchMode = !settings.watchMode;
  saveSettings();
  if (!settings.watchMode && watcher) watcher.stop('manual');
  petSay(settings.watchMode ? '好，陪看模式开了，发现你在看 B 站我就记。' : '陪看模式关了，不盯了。');
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/* ---------- 托盘 ---------- */
function buildTrayMenu() {
  const s = link.state || {};
  const status = link.online
    ? '信息管家：已连接' + (s.todos ? '（' + s.todos + ' 件待办）' : '')
    : '信息管家：未连接';
  const pendingTip = outboxCount() ? { label: '待同步到管家：' + outboxCount() + ' 条', enabled: false } : null;
  const items = [
    { label: status, enabled: false }
  ];
  if (pendingTip) items.push(pendingTip);
  items.push(
    { type: 'separator' },
    { label: '显示小机器人',
      click: () => { manualHidden = false; showWindow(); } },
    { label: '打开信息管家',
      click: () => openApp('focus') },
    { label: '快速记一条（Ctrl+Alt+Space）',
      click: () => openQuickNote() },
    { label: '收下剪贴板（Ctrl+Alt+V）',
      click: () => clipboardHarvest() },
    { label: '系统负载面板（浏览器）',
      click: () => openStatusPage() },
    { label: '陪看模式（看 B 站时自动记录）', type: 'checkbox', checked: settings.watchMode,
      click: () => toggleWatch() },
    watchReportItem(),
    latestReportItem(),
    reportCleanItem(),
    { type: 'separator' },
    cacheCleanItem(),
    { label: '看看谁在吃 CPU / 内存', click: () => showTopProcesses().catch(() => {}) },
    { type: 'separator' },
    { label: '跟随鼠标（Ctrl+Alt+F）', type: 'checkbox', checked: state.follow,
      click: () => { if (win) win.webContents.send('pet:follow', !state.follow); } },
    { label: '窗口置顶', type: 'checkbox', checked: state.top,
      click: (it) => {
        state.top = it.checked;
        if (win) win.setAlwaysOnTop(it.checked, 'screen-saver');
        if (win) win.webContents.send('pet:top', it.checked);
      } },
    { label: '回到右下角',
      click: () => { if (win) win.webContents.send('pet:reset'); } },
    { label: '皮肤', submenu: skinSubmenu() },
    { label: '全屏时自动隐身' + (fsUsable ? '' : '（本机不可用）'), type: 'checkbox',
      checked: settings.autoHide, enabled: fsUsable,
      click: (it) => {
        settings.autoHide = it.checked;
        saveSettings();
        if (!it.checked && fsHidden) setFsHidden(false);
      } },
    { label: '开机自启（随 Windows 启动）', type: 'checkbox', checked: settings.autoStart,
      click: (it) => { applyAutoStart(it.checked); } },
    { label: '游荡模式（在桌面上到处走走）', type: 'checkbox', checked: settings.wander,
      click: (it) => { setWander(it.checked); } },
    { label: '学习模式（打开猿编程自动变身）', type: 'checkbox', checked: settings.study !== false,
      click: (it) => { setStudy(it.checked); } },
    { label: '互动应用', submenu: [
      { label: '选择会搭理的应用…', click: () => openInteractPanel() },
      { label: '互动总开关', type: 'checkbox', checked: interactCfg().on !== false,
        click: (it) => { interactCfg().on = it.checked; saveSettings(); pushInteract(); } }
    ] },
    { type: 'separator' },
    { label: '重启小机器人（Ctrl+Alt+R）', click: () => restartApp() },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  );
  return Menu.buildFromTemplate(items);
}

function createTray() {
  const iconPath = path.join(__dirname, 'tray.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('3D 小机器人');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => showWindow());
}

/* ---------- IPC ---------- */
let moveLogAt = 0;
ipcMain.on('pet:move', (e, x, y) => {
  if (!win || win.isDestroyed()) return;
  const xi = Math.round(Number(x) || 0);
  const yi = Math.round(Number(y) || 0);
  const b = win.getBounds();
  if (b.x !== xi || b.y !== yi) {
    win.setPosition(xi, yi);
    // 调试用：PET_WANDER_LOG=1 时把移动轨迹打到控制台
    if (process.env.PET_WANDER_LOG) {
      const now = Date.now();
      if (now - moveLogAt > 1500) { moveLogAt = now; console.log('[wander] pos ' + xi + ',' + yi); }
    }
  }
});

ipcMain.on('pet:clickthrough', (e, v) => {
  if (!win || win.isDestroyed()) return;
  try { win.setIgnoreMouseEvents(!!v, { forward: !!v }); } catch (err) { /* ignore */ }
});

ipcMain.on('pet:wander-state', (e, v) => { setWander(!!v); });

ipcMain.on('pet:follow-state', (e, v) => {
  state.follow = !!v;
  if (tray) tray.setContextMenu(buildTrayMenu());
});

ipcMain.on('pet:always-top', (e, v) => {
  state.top = !!v;
  if (win) win.setAlwaysOnTop(state.top, 'screen-saver');
  if (tray) tray.setContextMenu(buildTrayMenu());
});

ipcMain.on('pet:quit', () => { quitting = true; app.quit(); });

/* ---------- 互动应用面板 IPC ---------- */
ipcMain.handle('interact:get', async () => {
  try {
    const r = await interactScan();
    interactSnapshot = { ids: Array.from(r.running), titles: r.titles, at: Date.now() };
  } catch (err) { /* 用上一次的快照 */ }
  return buildInteractState();
});

ipcMain.on('interact:set-on', (e, v) => {
  interactCfg().on = !!v;
  saveSettings();
  pushInteract();
});

ipcMain.on('interact:set-app', (e, p) => {
  if (!p || !p.id) return;
  const cfg = interactCfg();
  const id = String(p.id);
  const on = !!p.on;
  if (id.indexOf('c:') === 0) {
    const cu = cfg.custom.find((c) => 'c:' + c.id === id);
    if (cu) cu.on = on;
  } else if (id === 'bt') {
    cfg.bt = on;
    if (on) {
      btProbe().then((st) => { if (st !== 'unknown') btState = st; pushInteract(); }).catch(() => {});
    }
  } else if (INTERACT_APPS.some((a) => a.id === id)) {
    cfg.allow[id] = on;
  }
  saveSettings();
  pushInteract();
});

ipcMain.on('interact:test', (e, id) => { interactTest(String(id || '')); });

ipcMain.on('interact:add', (e, data) => {
  const cfg = interactCfg();
  const name = String((data && data.name) || '').trim().slice(0, 20);
  if (!name) return;
  const keys = (Array.isArray(data.keys) ? data.keys : [])
    .map((k) => String(k || '').trim().slice(0, 30))
    .filter(Boolean)
    .slice(0, 5);
  cfg.custom.push({
    id: 'u' + Date.now().toString(36),
    name,
    keys: keys.length ? keys : [name],
    on: true
  });
  saveSettings();
  pushInteract();
});

ipcMain.on('interact:del', (e, id) => {
  const cfg = interactCfg();
  cfg.custom = cfg.custom.filter((c) => 'c:' + c.id !== String(id || ''));
  saveSettings();
  pushInteract();
});

ipcMain.on('interact:close', () => {
  if (interactWin && !interactWin.isDestroyed()) interactWin.close();
});

/* ---------- 联动 IPC ---------- */
ipcMain.on('pet:link-request', () => broadcastLink());

ipcMain.on('pet:link-cmd', (e, cmd) => {
  openApp(typeof cmd === 'string' ? cmd : 'focus');
});

/* ---------- 快捷输入条 IPC ---------- */
ipcMain.on('qn:submit', (e, text) => {
  const item = outbox && outbox.add(text);
  if (!item) {
    if (qnWin && !qnWin.isDestroyed()) qnWin.webContents.send('qn:error', '写点什么再回车');
    return;
  }
  const sent = flushOutbox();
  if (qnWin && !qnWin.isDestroyed()) {
    qnWin.webContents.send('qn:ok', { queued: outboxCount(), sent: sent });
  }
  petSay(sent ? '记下了，正送进管家…' : ('记下了，等管家打开就同步（攒着 ' + outboxCount() + ' 条）'));
});

ipcMain.on('qn:hide', () => closeQuickNote());

/* ---------- 桌宠右下角菜单触发的桌面动作 ---------- */
ipcMain.on('pet:host-cmd', (e, name) => {
  if (name === 'quicknote') openQuickNote();
  else if (name === 'clipboard') clipboardHarvest();
  else if (name === 'hide') toggleManualHide();
  else if (name === 'watch') toggleWatch();
  else if (name === 'status') openStatusPage();
  else if (name === 'latest') openLatestReport();
  else if (name === 'clean') cleanReports().catch(() => {});
  else if (name === 'cache') cleanCaches().catch(() => {});
  else if (name === 'top') showTopProcesses().catch(() => {});
  else if (name === 'restart') restartApp();
  else if (name === 'ask') openApp('ask');
});

/* ---------- 原生右键菜单 ----------
   小机器人窗口只有 164x252，页内菜单经常被裁掉一截，索性用系统原生菜单 —— 永远完整。 */
ipcMain.on('pet:menu', (e, st) => {
  const s = st || {};
  const send = (act) => { try { e.sender.send('pet:menu-cmd', act); } catch (err) { /* 忽略 */ } };
  const items = [
    { label: '随手记一条（Ctrl+Alt+Space）', click: () => openQuickNote() },
    { label: '收下剪贴板（Ctrl+Alt+V）', click: () => clipboardHarvest() },
    { label: '系统负载面板（浏览器）', click: () => openStatusPage() },
    { type: 'separator' },
    { label: '打开信息管家', click: () => send('openapp') },
    { type: 'separator' },
    { label: s.follow ? '停止跟随' : '跟随鼠标', click: () => send('follow') },
    { label: s.tts ? '语音播报：开' : '语音播报：关', click: () => send('tts') },
    { label: s.top ? '取消置顶' : '窗口置顶', click: () => send('top') },
    { label: '回到右下角', click: () => send('reset') },
    { label: '隐身（Ctrl+Alt+H）', click: () => toggleManualHide() },
    { label: '皮肤', submenu: skinSubmenu() },
    { label: '开机自启（随 Windows 启动）', type: 'checkbox', checked: settings.autoStart,
      click: (it) => { applyAutoStart(it.checked); } },
    { label: '游荡模式（在桌面上到处走走）', type: 'checkbox', checked: settings.wander,
      click: (it) => { setWander(it.checked); } },
    { label: '学习模式（打开猿编程自动变身）', type: 'checkbox', checked: settings.study !== false,
      click: (it) => { setStudy(it.checked); } },
    { label: '互动应用', submenu: [
      { label: '选择会搭理的应用…', click: () => openInteractPanel() },
      { label: '互动总开关', type: 'checkbox', checked: interactCfg().on !== false,
        click: (it) => { interactCfg().on = it.checked; saveSettings(); pushInteract(); } }
    ] },
    { type: 'separator' },
    { label: '陪看模式（看 B 站时自动记录）', type: 'checkbox', checked: settings.watchMode, click: () => toggleWatch() },
    watchReportItem(),
    latestReportItem(),
    reportCleanItem(),
    { type: 'separator' },
    cacheCleanItem(),
    { label: '看看谁在吃 CPU / 内存', click: () => showTopProcesses().catch(() => {}) },
    { type: 'separator' },
    { label: '重启小机器人（Ctrl+Alt+R）', click: () => restartApp() },
    { label: '退出', click: () => send('quit') }
  ];
  try { Menu.buildFromTemplate(items).popup({ window: win && !win.isDestroyed() ? win : undefined }); } catch (err) { /* 忽略 */ }
});

/* ---------- 生命周期 ---------- */
let booted = false;
function boot() {
  if (booted) return;
  booted = true;

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
    }
  });

  // 诊断用：桌宠要是自己没了，日志里得留下原因（渲染进程崩溃 / 被系统回收 都不是无迹可寻）
  app.on('render-process-gone', (e, wc, d) => console.log('[life] 渲染进程没了：' + (d && d.reason)));
  app.on('child-process-gone', (e, d) => console.log('[life] 子进程没了：' + (d && d.type) + ' ' + (d && d.reason)));
  app.on('will-quit', () => console.log('[life] will-quit'));
  app.on('window-all-closed', () => console.log('[life] 所有窗口都关了，tray=' + (tray ? '有' : '没有')));

  app.whenReady().then(() => {
    loadLinkCache();
    loadOutbox();
    loadSettings();
    createWindow();
    createTray();
    // 便携版被移动/改名后，注册表里的旧路径会失效；自启开着就重写一次，自愈
    if (settings.autoStart) applyAutoStart(true);
    startCursorLoop();
    startPeekLoop();
    startStudyLoop();
    startInteractLoop();
    startBtLoop();
    // 调试用：PET_WANDER=1 启动即进入游荡；PET_OPEN_INTERACT=1 启动就打开互动面板
    if (process.env.PET_WANDER) setTimeout(() => setWander(true), 1200);
    if (process.env.PET_OPEN_INTERACT) setTimeout(() => openInteractPanel(), 1500);
    startSysLoop();
    startFullscreenWatch();
    startWatchLoop();

    bridge = createBridge({ onState: handleLinkState, onWatch: handleWatchResult });
    bridge.setCommandHandler(handlePetCommand);
    bridge.start().then((port) => {
      console.log('[bridge] listening on 127.0.0.1:' + (port || '(failed)'));
      flushOutbox();
      flushWatchPending();          // 上次没分析完的（管家当时没开 / 程序被关），这次补上
    });
    bridge.setStatusProvider(() => ({
      cpu: lastSys ? lastSys.cpu : 0,
      mem: lastSys ? lastSys.mem : 0,
      coreMax: lastSys ? lastSys.coreMax : 0,
      cores: lastSys ? lastSys.cores : 0,
      ts: lastSys ? lastSys.ts : 0,
      hist: sysHistory.slice(-120),
      watching: !!(watcher && watcher.status()),
      watch: watcher ? watcher.status() : null,
      link: { online: bridge.isOnline(), todos: link.state ? link.state.todos : 0 }
    }));

    // 全局快捷键：跟随时按钮会跟着窗口跑，必须有个系统级开关兜底
    const shortcuts = [
      ['CommandOrControl+Alt+F', '跟随开关', () => {
        state.follow = !state.follow;
        if (win) win.webContents.send('pet:follow', state.follow);
        if (tray) tray.setContextMenu(buildTrayMenu());
      }],
      ['CommandOrControl+Alt+Space', '随手记一条', () => openQuickNote()],
      ['CommandOrControl+Alt+V', '收下剪贴板', () => clipboardHarvest()],
      ['CommandOrControl+Alt+H', '隐身/现身', () => toggleManualHide()],
      ['CommandOrControl+Alt+B', '陪看开关', () => toggleWatch()],
      ['CommandOrControl+Alt+L', '打开最新陪看报告', () => openLatestReport()],
      ['CommandOrControl+Alt+R', '重启小机器人', () => restartApp()]
    ];
    for (const [accel, name, fn] of shortcuts) {
      let ok = false;
      try { ok = globalShortcut.register(accel, fn); } catch (e) { ok = false; }
      console.log('[shortcut] ' + accel + ' (' + name + ') ' + (ok ? 'registered' : 'register failed (可能被占用)'));
    }

    // 心跳过期检测：网页关掉后 45s 内没收到状态就判定离线
    linkTimer = setInterval(() => {
      if (bridge) bridge.checkTimeout();
    }, 5000);

    // 兜底：网络抖动时也要把攒着的记录送出去
    setInterval(() => { if (bridge && bridge.isOnline()) flushOutbox(); }, 8000);
  });

  app.on('window-all-closed', () => {
    // 托盘常驻：关掉窗口也先不退出，交给托盘菜单
    if (!tray) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (cursorTimer) clearInterval(cursorTimer);
    if (linkTimer) clearInterval(linkTimer);
    if (sysTimer) clearInterval(sysTimer);
    if (fsTimer) clearInterval(fsTimer);
    if (watchTimer) clearInterval(watchTimer);
    if (watcher) { try { watcher.stop('quit'); } catch (e) { /* 忽略 */ } }
    if (bridge) bridge.stop();
    try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ }
  });
}

/**
 * 抢单实例锁。一键重启时老进程可能还没退干净、锁还握在它手里 ——
 * 这时候直接 quit 的话，新进程会当场死掉，桌宠就从桌面上消失了。
 * 所以带 --relaunch 标记时隔 350ms 再抢，最多 8 次（约 3 秒）；
 * 平时重复双击没有这个标记，抢不到就立刻退出，不会反复抢焦点。
 */
const IS_RELAUNCH = process.argv.indexOf('--relaunch') >= 0;
function acquireLock(attempt) {
  if (app.requestSingleInstanceLock()) return boot();
  if (!IS_RELAUNCH || attempt >= 8) { app.quit(); return; }
  setTimeout(() => acquireLock(attempt + 1), 350);
}
acquireLock(0);
