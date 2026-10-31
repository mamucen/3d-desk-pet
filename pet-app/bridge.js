// 桌宠本地桥接服务：让「信息管家」网页与桌面小机器人互相通话
//
//  网页 --POST /state-->  桌宠    （待办数量、逾期数、最近归类结果、已入库回执 acked）
//  网页 <--GET  /poll--   桌宠    （长轮询，接收「打开管家」「记一条」「入库 ingest」指令）
//
// 只监听 127.0.0.1，仅本机可访问；端口 EADDRINUSE 时自动顺延。
'use strict';

const http = require('http');
const { URL } = require('url');

const PORTS = [17321, 17322, 17323, 17324];

/** 允许用 PET_BRIDGE_PORTS 换端口段（自动化测试用，免得抢占正在跑的那只桌宠） */
function defaultPorts() {
  const raw = process.env.PET_BRIDGE_PORTS;
  if (!raw) return PORTS;
  const list = String(raw).split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => n > 0 && n < 65536);
  return list.length ? list : PORTS;
}
const POLL_HOLD_MS = 25000;      // 长轮询挂起时长
const ONLINE_TTL_MS = 90000;     // 心跳超时即视为离线
const PENDING_MAX = 20;          // 没有长轮询挂起时，先攒着的指令条数上限

function createBridge(options) {
  const opts = options || {};
  const ports = Array.isArray(opts.ports) && opts.ports.length ? opts.ports : defaultPorts();
  const onState = typeof opts.onState === 'function' ? opts.onState : () => {};
  const onWatch = typeof opts.onWatch === 'function' ? opts.onWatch : () => {};
  let statusProvider = null;

  let server = null;
  let port = 0;
  let state = null;
  let appUrl = '';
  let lastSeen = 0;
  let seq = 0;
  const waiters = new Set();
  const pending = [];            // 网页还没连上时先存着，等它来取

  function isOnline() {
    return lastSeen > 0 && Date.now() - lastSeen < ONLINE_TTL_MS;
  }

  function applyCors(req, res) {
    // 网页从 https 源访问 http://127.0.0.1 属于「私有网络请求」，需放行预检
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  function sendJson(res, code, body) {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  }

  function reply(res, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
  }

  /**
   * 把指令推给所有挂起的长轮询。
   * 支持 { cmd, items } 这种带数据的指令；没有挂起的连接时先入队，
   * 等下一次 /poll 到达再交出去（否则网页刚连上的那一下会丢指令）。
   */
  function push(payload) {
    const p = typeof payload === 'string' ? { cmd: payload } : (payload || {});
    if (!p.cmd) return false;
    p.seq = ++seq;
    p.ts = Date.now();

    if (!waiters.size) {
      pending.push(p);
      while (pending.length > PENDING_MAX) pending.shift();
      return false;
    }
    for (const res of waiters) {
      try { reply(res, p); } catch (err) { /* 连接已断开，忽略 */ }
    }
    waiters.clear();
    return true;
  }

  function handleState(req, res) {
    let raw = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) { tooLarge = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooLarge) return;
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: 'invalid json' });
      }
      if (body && typeof body.appUrl === 'string' && body.appUrl) {
        appUrl = body.appUrl.slice(0, 500);
      }
      if (body && body.state && typeof body.state === 'object') {
        state = body.state;
      }
      const wasOnline = isOnline();
      lastSeen = Date.now();
      sendJson(res, 200, { ok: true, ts: lastSeen });
      onState({
        online: true,
        state,
        appUrl,
        changed: !wasOnline,
        // 网页回执：哪几条桌面记的内容已经落库了
        acked: body && Array.isArray(body.acked) ? body.acked.slice(0, 50) : null
      });
    });
  }

  function handlePoll(req, res) {
    waiters.add(res);

    // 先把攒着的指令交出去（网页刚连上时最常见的场景）
    if (pending.length) {
      const next = pending.shift();
      waiters.delete(res);
      return reply(res, next);
    }

    const timer = setTimeout(() => {
      if (waiters.delete(res)) sendJson(res, 200, { cmd: null, seq });
    }, POLL_HOLD_MS);
    req.on('close', () => {
      clearTimeout(timer);
      waiters.delete(res);
    });
  }

  function handleWatchResult(req, res) {
    let raw = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) { tooLarge = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooLarge) return;
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (err) {
        return sendJson(res, 400, { ok: false, error: 'invalid json' });
      }
      if (!body || !body.sid) return sendJson(res, 400, { ok: false });
      onWatch({ sid: String(body.sid), result: body.result || null });
      sendJson(res, 200, { ok: true });
    });
  }

  /** 系统负载监控页（用浏览器打开，机器人机箱太小看不过瘾） */
  const STATUS_HTML = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>系统负载 · 小机器人</title><style>' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{background:#0d1311;color:#e6eeea;font-family:"Microsoft YaHei",system-ui,sans-serif;padding:48px 7vw}' +
    'h1{font-size:17px;letter-spacing:4px;color:#2fbf8f;font-weight:700;margin-bottom:6px}' +
    '.sub{color:#6f877e;font-size:13px;margin-bottom:34px}' +
    '.top{display:flex;gap:40px;align-items:flex-end;flex-wrap:wrap}' +
    '.big{font-size:96px;line-height:1;font-weight:800;color:#7df0c0;font-variant-numeric:tabular-nums}' +
    '.big i{font-style:normal;font-size:26px;color:#4e8c7c}' +
    '.stat{font-size:14px;color:#9fb3ab;line-height:1.9}' +
    '.stat b{color:#e6eeea;font-variant-numeric:tabular-nums}' +
    'canvas{width:100%;height:220px;margin-top:36px;border-radius:14px;background:#101815;border:1px solid rgba(255,255,255,.07)}' +
    '.hot{color:#ff8f5e !important}' +
    '</style></head><body>' +
    '<h1>系统负载</h1><div class="sub" id="sub">这台机器上的小机器人每秒采一次样</div>' +
    '<div class="top"><div><div class="big" id="cpu">--<i>%</i></div></div>' +
    '<div class="stat">最忙的核 <b id="core">--</b>%<br>内存占用 <b id="mem">--</b>%<br>CPU 核心数 <b id="cores">--</b> 核<br>陪看状态 <b id="watch">--</b></div></div>' +
    '<canvas id="chart" width="1600" height="440"></canvas>' +
    '<script>' +
    'var hist=[];' +
    'function watchText(w){' +
    'var t=(w&&w.title)?String(w.title):"看视频";if(t.length>18)t=t.slice(0,18)+"…";' +
    'var parts=[];' +
    'if(typeof w.frames==="number")parts.push(w.frames+" 帧");' +
    'if(typeof w.startedAt==="number"){var m=Math.max(1,Math.round((Date.now()-w.startedAt)/60000));parts.push(m+" 分钟");}' +
    'return "录制中："+t+(parts.length?"（"+parts.join(" · ")+"）":"");}' +
    'function draw(){var c=document.getElementById("chart");var g=c.getContext("2d");' +
    'var W=c.width,H=c.height;g.clearRect(0,0,W,H);' +
    'g.strokeStyle="rgba(255,255,255,.06)";g.lineWidth=1;' +
    'for(var y=0;y<=4;y++){var yy=H-y*(H-40)/4-20;g.beginPath();g.moveTo(0,yy);g.lineTo(W,yy);g.stroke();}' +
    'if(hist.length<2)return;' +
    'var n=Math.max(hist.length,60);var px=function(i){return i/(n-1)*W};var py=function(v){return H-20-(v/100)*(H-40)};' +
    'function line(key,color,width){g.beginPath();for(var i=0;i<hist.length;i++){var x=px(i),y=py(hist[i][key]);if(i)g.lineTo(x,y);else g.moveTo(x,y)}g.strokeStyle=color;g.lineWidth=width;g.stroke()}' +
    'g.beginPath();g.moveTo(0,py(0));for(var i=0;i<hist.length;i++)g.lineTo(px(i),py(hist[i].cpu));g.lineTo(px(hist.length-1),py(0));g.closePath();' +
    'var grd=g.createLinearGradient(0,0,0,H);grd.addColorStop(0,"rgba(47,191,143,.35)");grd.addColorStop(1,"rgba(47,191,143,0)");g.fillStyle=grd;g.fill();' +
    'line("cpu","#5ee0a8",2.5);line("coreMax","rgba(240,169,60,.85)",1.5);line("mem","rgba(90,182,240,.6)",1.5);}' +
    'function fmt(d){var el=document.getElementById("cpu");var v=d.cpu;el.innerHTML=v+"<i>%</i>";el.className=v>=80?"big hot":"big";' +
    'document.getElementById("core").textContent=d.coreMax;document.getElementById("mem").textContent=d.mem;' +
    'document.getElementById("cores").textContent=d.cores;' +
    'document.getElementById("watch").textContent=d.watch?watchText(d.watch):(d.watching?"录制中":"空闲");' +
    // 桌面端带着历史一起给，首次打开曲线就是满的；之后按时间戳去重，一秒一格继续滚
    'if(d.hist&&d.hist.length&&d.hist.length>=hist.length+2){hist=d.hist.slice(-240);}' +
    'else{var last=hist[hist.length-1];if(!(last&&last.ts===d.ts)){hist.push(d);if(hist.length>240)hist.shift();}}' +
    'draw();}' +
    'function poll(){fetch("/sys",{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){if(d&&typeof d.cpu==="number")fmt(d)}).catch(function(){})}' +
    'poll();setInterval(poll,1000);' +
    '</script></body></html>';

  function sendHtml(res, html) {
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  }

  function route(req, res) {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch (err) {
      return sendJson(res, 400, { ok: false });
    }

    if (pathname === '/health') {
      return sendJson(res, 200, { app: 'desk-pet', online: isOnline(), version: 1 });
    }
    if (pathname === '/status') {
      return sendHtml(res, STATUS_HTML);
    }
    if (pathname === '/sys') {
      return sendJson(res, 200, statusProvider ? statusProvider() : { error: 'no provider' });
    }
    if (pathname === '/state' && req.method === 'POST') {
      return handleState(req, res);
    }
    if (pathname === '/watch-result' && req.method === 'POST') {
      return handleWatchResult(req, res);
    }
    if (pathname === '/poll') {
      return handlePoll(req, res);
    }
    return sendJson(res, 404, { ok: false });
  }

  function listen(index) {
    return new Promise((resolve, reject) => {
      const candidate = ports[index];
      const s = http.createServer(route);
      s.once('error', (err) => {
        s.close(() => {});
        if (err && err.code === 'EADDRINUSE' && index + 1 < ports.length) {
          resolve(listen(index + 1));
        } else {
          reject(err);
        }
      });
      s.listen(candidate, '127.0.0.1', () => {
        server = s;
        port = candidate;
        resolve(candidate);
      });
    });
  }

  return {
    async start() {
      if (server) return port;
      try {
        await listen(0);
        return port;
      } catch (err) {
        port = 0;
        return 0;
      }
    },
    setStatusProvider: (fn) => { statusProvider = typeof fn === 'function' ? fn : null; },
    stop() {
      for (const res of waiters) {
        try { res.destroy(); } catch (e) { /* ignore */ }
      }
      waiters.clear();
      if (server) { server.close(); server = null; port = 0; }
    },
    push,
    isOnline,
    getPort: () => port,
    getState: () => state,
    getAppUrl: () => appUrl,
    /** 心跳过期检测：由外部定时器驱动，返回是否刚刚掉线 */
    checkTimeout() {
      if (lastSeen > 0 && !isOnline()) {
        lastSeen = 0;
        onState({ online: false, state, appUrl, changed: true });
        return true;
      }
      return false;
    }
  };
}

module.exports = { createBridge, PORTS };
