/**
 * 桌面小机器人联动桥
 *
 * 桌宠（Electron）在本机 127.0.0.1 上开了一个小服务，这里负责：
 *   1. 探测端口（17321 起，最多试 4 个）
 *   2. 把待办状态推给它（变化时 + 20s 心跳）
 *   3. 长轮询接收它发来的指令（打开管家 / 记一条 / 看待办）
 *
 * 桌宠没开就静默降级，不影响信息管家本身的任何功能。
 */
(function () {
  'use strict';

  var K = window.Keeper;
  if (!K) return;

  // 测试可通过 window.__PET_BRIDGE_PORTS__ 换到独立端口段，
  // 避免测试流量打到正在运行的真机器人上（曾因此污染过它的缓存）
  var PORTS = (window.__PET_BRIDGE_PORTS__ && window.__PET_BRIDGE_PORTS__.length)
    ? window.__PET_BRIDGE_PORTS__
    : [17321, 17322, 17323, 17324];
  var HEARTBEAT_MS = 20000;
  var RETRY_MS = 8000;
  var MIN_GAP_MS = 600;
  var EVENT_TTL_MS = 60000;

  var base = '';
  var online = false;
  var started = false;
  var connecting = false;
  var polling = false;
  var heartbeat = null;
  var retryTimer = null;
  var trailing = null;
  var lastPushAt = 0;
  var eventSeq = 0;
  var pendingEvent = null;
  var ackQueue = [];          // 已入库、等回执给桌宠的条目
  var seenIds = {};           // 处理过的 id，防止重复入库

  try {
    var cachedIds = JSON.parse(localStorage.getItem('pet.ingested') || '[]');
    if (Object.prototype.toString.call(cachedIds) === '[object Array]') {
      cachedIds.forEach(function (id) { if (id) seenIds[id] = 1; });
    }
  } catch (err) { /* 忽略 */ }

  function rememberIds(ids) {
    ids.forEach(function (id) { if (id) seenIds[id] = 1; });
    try {
      var all = Object.keys(seenIds);
      if (all.length > 80) all = all.slice(-80);
      seenIds = {};
      all.forEach(function (id) { seenIds[id] = 1; });
      localStorage.setItem('pet.ingested', JSON.stringify(all));
    } catch (err) { /* 忽略 */ }
  }

  /* ---------------- 状态快照 ---------------- */

  function buildPayload() {
    var snap = { todos: 0, overdue: 0, today: 0, upcoming: 0, notes: 0, pendingAi: 0, next: [], ts: Date.now() };
    try {
      if (K.app && K.app.snapshot) snap = K.app.snapshot();
    } catch (err) { /* 用默认值兜底 */ }

    if (pendingEvent) {
      if (Date.now() - pendingEvent.at > EVENT_TTL_MS) {
        pendingEvent = null;
      } else {
        snap.event = {
          id: pendingEvent.id,
          type: pendingEvent.type,
          kind: pendingEvent.kind,
          title: pendingEvent.title,
          category: pendingEvent.category,
          tags: pendingEvent.tags,
          related: pendingEvent.related
        };
      }
    }

    // 带上完整地址（含分享码），桌宠需要用它把信息管家重新打开
    var body = { appUrl: location.href, state: snap };
    if (ackQueue.length) body.acked = ackQueue.slice(0, 50);
    return body;
  }

  /* ---------------- 端口探测 ---------------- */

  function probePort(port) {
    var url = 'http://127.0.0.1:' + port;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 800);
    return fetch(url + '/health', { signal: ctrl.signal, cache: 'no-store' })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) return null;
        return res.json().then(function (data) {
          return (data && data.app === 'desk-pet') ? url : null;
        }).catch(function () { return null; });
      })
      .catch(function () {
        clearTimeout(timer);
        return null;
      });
  }

  async function probe() {
    for (var i = 0; i < PORTS.length; i++) {
      var found = await probePort(PORTS[i]);
      if (found) return found;
    }
    return '';
  }

  /* ---------------- 推送 ---------------- */

  function push(force) {
    if (!online || !started) return;

    var now = Date.now();
    if (!force && now - lastPushAt < MIN_GAP_MS) {
      clearTimeout(trailing);
      trailing = setTimeout(function () { push(true); }, MIN_GAP_MS);
      return;
    }
    lastPushAt = now;

    var body;
    try {
      body = JSON.stringify(buildPayload());
    } catch (err) {
      return;
    }

    fetch(base + '/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      cache: 'no-store'
    }).then(function (res) {
      if (!res.ok) throw new Error('push failed');
      pendingEvent = null;
      ackQueue = [];                 // 已经送达，桌宠拿到回执会清掉待同步
    }).catch(function () {
      goOffline();
    });
  }

  /* ---------------- 长轮询：接收桌宠指令 ---------------- */

  async function poll() {
    if (polling) return;
    polling = true;

    while (online && started) {
      var data = null;
      try {
        var res = await fetch(base + '/poll', { cache: 'no-store' });
        if (!res.ok) throw new Error('poll failed');
        data = await res.json();
      } catch (err) {
        polling = false;
        goOffline();
        return;
      }
      if (data && data.cmd) handleCommand(data);
    }
    polling = false;
  }

  /* 桌面端记了几条，灌进管家：逐条建条目，成功后回执（桌宠据此清空待同步队列） */
  async function handleIngest(items) {    if (!items || !items.length || !K.app || !K.app.ingestOne) {
      push(true);
      return;
    }
    var results = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.id || typeof it.text !== 'string') continue;
      if (seenIds[it.id]) { results.push({ id: it.id, ok: true }); continue; }   // 重复投递，直接确认
      try {
        var note = await K.app.ingestOne(it.text);
        rememberIds([it.id]);
        results.push({ id: it.id, ok: true, noteId: note && note.id });
      } catch (err) {
        console.warn('[pet-bridge] 入库失败', err && err.message);
        results.push({ id: it.id, ok: false });
      }
    }
    if (results.length) {
      ackQueue = ackQueue.concat(results);
      while (ackQueue.length > 50) ackQueue.shift();
      push(true);
    }
  }

  /* ---------------- 陪看：视频截图 → 观点 ---------------- */

  function composeWatchNote(payload, result) {
    var lines = ['【陪看】' + (payload.title || 'B 站视频')];
    // 认出了 B 站视频就把出处记下来，回头翻笔记能顺着 BV 号回去看
    var up = /UP 主：(.+)/.exec(payload.bili || '');
    if (up) lines.push('UP 主：' + up[1].trim());
    if (payload.bvid) lines.push('B 站：' + payload.bvid);
    if (result.rating) {
      lines.push('推荐指数：' + result.rating.toFixed(1) + ' / 10' + (result.vision ? '' : '（这次只看到标题，没看到画面）'));
    }
    lines.push('观点：' + result.verdict);
    if (result.points && result.points.length) lines.push('要点：\n- ' + result.points.join('\n- '));
    if (result.audience) lines.push('适合谁看：' + result.audience);
    return lines.join('\n');
  }

  async function handleWatchAnalyze(payload) {
    var sid = payload && payload.sid;
    function reply(result) {
      fetch(base + '/watch-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: sid, result: result }),
        cache: 'no-store'
      }).catch(function () { /* 桌宠可能刚好关了 */ });
    }

    try {
      if (!K.ai || !K.ai.available()) throw new Error('AI 暂时不可用');
      var result = await K.ai.analyzeVideo({
        title: payload.title,
        frames: payload.frames,
        bili: payload.bili || '',       // 桌宠从 B 站抓来的标题/简介/弹幕，有就以它为主
        bvid: payload.bvid || ''
      });
      reply(result);
      // 顺手把这条看片笔记存进管家（用户选了“顺手存”）
      if (K.app && K.app.ingestOne) {
        K.app.ingestOne(composeWatchNote(payload, result)).catch(function () { /* 不阻塞 */ });
      }
    } catch (err) {
      reply({ verdict: '这次没分析成：' + ((err && err.message) || '未知错误'), points: [], rating: 0, tags: [] });
    }
  }

  function handleCommand(data) {
    try {
      var cmd = data.cmd;
      if (cmd === 'ingest') {
        handleIngest(data.items);
        return;
      }
      if (cmd === 'watch-analyze') {
        handleWatchAnalyze(data);
        return;
      }
      if (cmd === 'ask') {
        if (K.app && K.app.ask) K.app.ask();
        window.focus();
      } else if (cmd === 'note' || cmd === 'focus') {
        if (K.app && K.app.focusComposer) K.app.focusComposer(cmd);
        window.focus();
      } else if (cmd === 'todo') {
        if (K.app && K.app.showTodo) K.app.showTodo();
        window.focus();
      }
    } catch (err) { /* 指令失败不影响主流程 */ }
  }

  /* ---------------- 连接生命周期 ---------------- */

  function startHeartbeat() {
    stopHeartbeat();
    heartbeat = setInterval(function () { push(true); }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  }

  function scheduleRetry() {
    if (!started || online) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, RETRY_MS);
  }

  function goOffline() {
    var was = online;
    online = false;
    polling = false;
    stopHeartbeat();
    paint();
    if (was) console.info('[pet-bridge] 小机器人断开了');
    scheduleRetry();
  }

  async function connect() {
    if (!started || online || connecting) return;
    connecting = true;
    var found = await probe();
    connecting = false;
    if (!started) return;

    if (!found) {
      scheduleRetry();
      return;
    }

    base = found;
    online = true;
    paint();
    push(true);
    poll();
    startHeartbeat();
    console.info('[pet-bridge] 已连接小机器人 ' + base);
  }

  /* ---------------- 侧栏状态点 ---------------- */

  function paint() {
    var host = document.querySelector('.side-foot');
    if (!host || !host.parentNode) return;
    var el = document.getElementById('petLink');
    if (!el) {
      el = document.createElement('div');
      el.id = 'petLink';
      el.className = 'pet-link';
      host.parentNode.insertBefore(el, host);   // 放在用户卡片上方，独占一行
    }
    el.classList.toggle('on', online);
    el.title = online ? '桌面小机器人正在同步这里的数据' : '打开「启动小机器人.bat」即可联动';
    el.innerHTML = '<i></i><span>' + (online ? '桌面小机器人已连接' : '桌面小机器人未运行') + '</span>';
  }

  /* ---------------- 对外接口 ---------------- */

  K.pet = {
    start: function () {
      if (started) return;
      started = true;
      paint();
      connect();
      if (!K.pet.__bound) {
        K.pet.__bound = true;
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) push(true);
        });
        window.addEventListener('beforeunload', function () {
          // 主动断一下长轮询，桌宠能立刻感知到页面关了
          try { navigator.sendBeacon && navigator.sendBeacon(base + '/state', '{}'); } catch (e) { /* 忽略 */ }
        });
      }
    },

    stop: function () {
      started = false;
      online = false;
      polling = false;
      stopHeartbeat();
      clearTimeout(retryTimer);
      clearTimeout(trailing);
      pendingEvent = null;
      paint();
    },

    /** 主流程调用：状态有变化就推一次 */
    sync: function (force) { push(!!force); },

    /** 主流程调用：播报一条事件（目前用于 AI 归类完成） */
    event: function (payload) {
      pendingEvent = Object.assign({ id: ++eventSeq, at: Date.now() }, payload || {});
      push(true);
    },

    isOnline: function () { return online; }
  };
})();
