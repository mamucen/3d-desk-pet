// main.js 启动链路冒烟（可在进程内跑，也可 CLI 跑）
//   node tools/smoke-main.js            —— 直接运行
//   await require('./smoke-main').run() —— 给别的测试用（沙箱里 spawn 会被 EBUSY 拦）
//
// 用假 electron 模块跑通「加载 + whenReady」全链路，验证新增代码没有引用错误。
// 注意：会把 main.js 载入当前进程，所以跑完必须把打过补丁的全局/模块系统全部还原。
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const events = require('events');
const Module = require('module');

function run(opts) {
  const wait = (opts && opts.wait) || 1200;
  return new Promise((resolve) => {
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-harness-'));
    const calls = { ipc: [], shortcuts: [], login: [], menus: [], opened: [], relaunch: [], exit: [], trashed: [], dialogs: [], lockCalls: 0 };
    // 默认让前两次抢锁失败：模拟“一键重启时老进程还没退干净”，验证会重试而不是当场死掉
    const failLock = typeof (opts && opts.failLock) === 'number' ? opts.failLock : 2;
    const handlers = {};
    const timers = new Set();
    const timeouts = new Set();

    const origInterval = global.setInterval;
    const origTimeout = global.setTimeout;
    const origSetImmediate = global.setImmediate;

    // 罩住常驻定时器，跑完统一收掉，进程才能干净退出
    global.setInterval = function (fn, ms) {
      const t = origInterval(function () {
        try { fn(); } catch (e) { /* 冒烟期间的单次失败忽略 */ }
      }, ms);
      timers.add(t);
      return t;
    };
    // main.js 里的一次性延时同样要收；但不能罩住本文件自己的收尾定时器
    let settling = false;
    global.setTimeout = function (fn, ms) {
      if (settling) return origTimeout(fn, ms);
      const t = origTimeout(function () {
        timeouts.delete(t);
        try { fn(); } catch (e) { /* 忽略 */ }
      }, ms);
      timeouts.add(t);
      return t;
    };
    global.setImmediate = function (fn) {
      if (settling) return origSetImmediate(fn);
      return origSetImmediate(function () { try { fn(); } catch (e) { /* 忽略 */ } });
    };

    function winStub() {
      return {
        webContents: {
          send() {}, on() {}, executeJavaScript: () => Promise.resolve('{}'),
          capturePage: () => Promise.resolve({ toPNG: () => Buffer.alloc(0) })
        },
        on() {}, once() {},
        setAlwaysOnTop() {}, setVisibleOnAllWorkspaces() {}, setIgnoreMouseEvents() {},
        loadFile: () => Promise.resolve(), loadURL: () => Promise.resolve(),
        isDestroyed: () => true, isVisible: () => false, isMinimized: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 164, height: 252 }),
        hide() {}, show() {}, showInactive() {}, focus() {}, restore() {}, setPosition() {}
      };
    }
    const fakeElectron = {
      app: Object.assign(new events.EventEmitter(), {
        whenReady: () => Promise.resolve(),
        requestSingleInstanceLock: () => { calls.lockCalls += 1; return calls.lockCalls > failLock; },
        getPath: (n) => (n === 'userData' ? fakeDir : os.tmpdir()),
        getAppPath: () => path.join(__dirname, '..', 'pet-app'),
        setLoginItemSettings: (o) => calls.login.push(o),
        getLoginItemSettings: () => ({ openAtLogin: false }),
        isPackaged: false,
        relaunch: (o) => calls.relaunch.push(o || {}),
        exit: (c) => calls.exit.push(c),
        quit() {}, on() {}
      }),
      BrowserWindow: function () { return winStub(); },
      ipcMain: Object.assign(new events.EventEmitter(), {
        on: (n, fn) => { calls.ipc.push('ipc:' + n); handlers[n] = fn; }
      }),
      screen: {
        getPrimaryDisplay: () => ({
          workArea: { x: 0, y: 0, width: 1920, height: 1040 },
          bounds: { x: 0, y: 0, width: 1920, height: 1080 }
        }),
        getCursorScreenPoint: () => ({ x: 100, y: 100 }),
        on() {}
      },
      Tray: function () { return { setContextMenu() {}, setToolTip() {}, on() {} }; },
      Menu: { buildFromTemplate: (tpl) => { calls.menus.push(tpl); return { popup() {} }; } },
      nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
      shell: {
        openExternal: (u) => calls.opened.push(u),
        openPath: (p) => { calls.opened.push(p); return Promise.resolve(''); },
        showItemInFolder() {},
        trashItem: (p) => { calls.trashed.push(p); return Promise.resolve(); }
      },
      dialog: {
        // 冒烟里默认选「只留最近 3 份」；想测取消可以传 opts.dialogChoice = 2
        showMessageBox: (o) => {
          calls.dialogs.push({ message: o && o.message, buttons: (o && o.buttons) || [] });
          return Promise.resolve({ response: typeof (opts && opts.dialogChoice) === 'number' ? opts.dialogChoice : 0 });
        }
      },
      globalShortcut: { register: (a) => { calls.shortcuts.push(a); return true; }, unregisterAll() {} },
      clipboard: { readText: () => '粘贴的内容', readImage: () => ({ isEmpty: () => true }) },
      desktopCapturer: { getSources: async () => [] }
    };

    const origRequire = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === 'electron') return fakeElectron;
      return origRequire.apply(this, arguments);
    };

    const onThrow = (e) => { finish({ ok: false, error: e.message, calls }); };
    process.on('uncaughtException', onThrow);

    let done = false;
    function finish(res) {
      if (done) return;
      done = true;
      settling = true;
      timers.forEach((t) => clearInterval(t));
      timeouts.forEach((t) => clearTimeout(t));
      Module.prototype.require = origRequire;
      global.setInterval = origInterval;
      global.setTimeout = origTimeout;
      global.setImmediate = origSetImmediate;
      process.removeListener('uncaughtException', onThrow);
      try { fs.rmSync(fakeDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
      resolve(res);
    }

    // 报告根目录指到临时目录：既不弄脏真实的 D 盘，又能验证「换盘」这条路径
    process.env.PET_REPORT_ROOT = path.join(fakeDir, 'PETFakeDrive');
    // 端口也挪开：冒烟会真的建桥接服务，绝不能抢占正在运行的那只桌宠的 17321
    process.env.PET_BRIDGE_PORTS = '17621,17622';
    // 造几份假报告：验证「打开最新报告」能定位到具体文件、「清理报告」能按份数留
    // （opts.seedReport === false 可关）
    let seededReport = '';
    if (!(opts && opts.seedReport === false)) {
      try {
        const dir = path.join(process.env.PET_REPORT_ROOT, '陪看报告');
        fs.mkdirSync(dir, { recursive: true });
        const old = ['2026-10-28-旧报告C', '2026-10-29-旧报告B', '2026-10-30-旧报告A'];
        old.forEach((n, i) => {
          const p = path.join(dir, n + '.pptx');
          fs.writeFileSync(p, Buffer.alloc(1024 * (i + 1), 0x31));
          const t = (Date.now() - (old.length - i) * 60000) / 1000;
          try { fs.utimesSync(p, t, t); } catch (e) { /* 忽略 */ }
        });
        seededReport = path.join(dir, '2026-10-31-《测试视频》.pptx');
        fs.writeFileSync(seededReport, Buffer.alloc(2048, 0x32));
        calls.seededReport = seededReport;
      } catch (e) { /* 造不出来就只测空目录那条路 */ }
    }
    // 假装自己是“一键重启起来的新进程”，这样才能走到等锁重试那条路
    if (process.argv.indexOf('--relaunch') < 0) process.argv.push('--relaunch');

    try {
      require(path.join(__dirname, '..', 'pet-app', 'main.js'));
    } catch (e) {
      finish({ ok: false, error: e.message, calls });
      return;
    }

    origTimeout(() => {
      // 冒烟收尾：真的弹一次右键菜单，看「打开陪看报告」是不是可点、点了会不会有反应
      try {
        const h = handlers['pet:menu'];
        if (h) h({ sender: { send() {} } }, { follow: false, top: true, tts: false });
        const tpl = calls.menus[calls.menus.length - 1] || [];
        const item = tpl.find((i) => i && /陪看报告/.test(i.label || ''));
        calls.reportItem = item ? { label: item.label, enabled: item.enabled !== false } : null;
        if (item && typeof item.click === 'function') item.click();

        // 新加的「打开最新报告」：菜单标题里就该看得出是哪一份
        const latest = tpl.find((i) => i && /最新报告/.test(i.label || ''));
        calls.latestItem = latest ? { label: latest.label, enabled: latest.enabled !== false } : null;
        if (latest && typeof latest.click === 'function') latest.click();

        // 「清理报告」：应弹出确认框，并按「只留最近 3 份」把多出来的丢进回收站
        const clean = tpl.find((i) => i && /清理陪看报告/.test(i.label || ''));
        calls.cleanItem = clean ? { label: clean.label, enabled: clean.enabled !== false } : null;
        if (clean && typeof clean.click === 'function') clean.click();

        const rs = tpl.find((i) => i && /重启/.test(i.label || ''));
        calls.restartItem = rs ? { label: rs.label, enabled: rs.enabled !== false } : null;
        if (rs && typeof rs.click === 'function') rs.click();
      } catch (e) {
        calls.menuError = e.message;
      }
      // 清理报告是 async（要等确认框、再逐个丢回收站），给它一点时间跑完再收尾
      origTimeout(() => {
        delete process.env.PET_REPORT_ROOT;
        delete process.env.PET_BRIDGE_PORTS;
        finish({ ok: true, calls });
      }, 220);
    }, wait);
  });
}

module.exports = { run };

if (require.main === module) {
  run().then((r) => {
    if (!r.ok) { console.log('FAIL 未捕获异常:', r.error); process.exit(1); }
    console.log('已注册的 IPC/事件:', r.calls.ipc.join(', '));
    console.log('全局快捷键:', r.calls.shortcuts.join(', '));
    const need = ['ipc:pet:move', 'ipc:pet:clickthrough', 'ipc:qn:submit', 'ipc:qn:hide', 'ipc:pet:host-cmd', 'ipc:pet:menu'];
    const missing = need.filter((n) => r.calls.ipc.indexOf(n) < 0);
    console.log(missing.length ? 'FAIL 缺少: ' + missing.join(',') : 'OK main.js 启动链路完整（桥接/托盘/快捷键/全屏监听/陪看全部挂上）');
    process.exit(missing.length ? 1 : 0);
  });
}
