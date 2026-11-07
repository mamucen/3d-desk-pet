// 陪看模式：盯着 B 站窗口，按节奏抓关键帧，看完把素材交给上层去“发表观点”。
//
// 几个设计取舍：
//   1. 只抓「标题像视频页」的 B 站窗口 —— 首页/搜索结果页不录，避免一打开浏览器就开始记录；
//   2. 省资源的两段式采样：平时只问窗口标题（不产生任何位图，几乎零开销），
//      真到采样点、真要那张图了，才去抓一次缩略图 —— 不看不抓，这点很关键；
//   3. 自适应采样：起步 6 秒一帧；攒满上限就把帧数减半、间隔翻倍 —— 不管视频多长，
//      最后都覆盖全片，而且总量恒定（默认 24 张）；
//   4. 画面没变（暂停、静止画面）不重复存，省体积也省 AI 的 token；
//   5. 结束条件：窗口关掉、切到别的视频、长时间无变化、或用户手动停。
//
// 帧存在 userData/watch/<会话 id>/ 下，只保留最近 KEEP_SESSIONS 场，更早的自动删。
'use strict';

const fs = require('fs');
const path = require('path');

const BILI_RE = /(哔哩哔哩|bilibili)/i;
const START_INTERVAL = 6000;     // 起步采样间隔
const MAX_FRAMES = 24;           // 单次会话最多留多少张
const FRAME_W = 960;             // 存盘宽度（做汇总图够用）
const AI_W = 720;                // 送分析的宽度（省 token）
const CHANGE_EPS = 3.2;          // 画面平均差异阈值，低于它算“没动”
const END_SILENT_MS = 120000;    // 画面长时间没变化 → 认为看完了
const END_GONE_MS = 15000;       // 窗口消失多久算关掉了
const MAX_SESSION_MS = 45 * 60000;
const KEEP_SESSIONS = 8;         // 磁盘上最多留几场的原帧（一场约 2MB）

/** "【某某】标题_哔哩哔哩_bilibili" → "【某某】标题" */
function cleanTitle(name) {
  let t = String(name == null ? '' : name);
  t = t.replace(/\s*[-_|·—]\s*哔哩哔哩.*$/i, '');
  t = t.replace(/\s*[-_|·—]\s*bilibili.*$/i, '');
  t = t.replace(/\s*[-_|·—]\s*\(?゜.*$/i, '');
  return t.replace(/\s+/g, ' ').trim();
}

/** 是不是一个「视频页」的窗口标题（首页、搜索页不算） */
function isVideoTitle(name) {
  const s = String(name == null ? '' : name);
  if (!BILI_RE.test(s)) return false;
  const t = cleanTitle(s);
  if (!t || /^(哔哩哔哩|bilibili)/i.test(t)) return false;
  return t.length >= 6;
}

/** 32x18 的灰度指纹，用来判断画面有没有动 */
function fingerprint(img) {
  try {
    const small = img.resize({ width: 32, height: 18, quality: 'good' });
    const buf = small.toBitmap();          // BGRA
    const out = [];
    for (let i = 0; i + 3 < buf.length; i += 4 * 5) out.push(buf[i], buf[i + 1], buf[i + 2]);
    return out;
  } catch (err) {
    return null;
  }
}

function diff(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function safeName(s) {
  return String(s || 'video').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function createWatcher(options) {
  const opts = options || {};
  // capture({thumbnails:false}) → [{id,name}]（不要位图，便宜）
  // capture({thumbnails:true})  → [{id,name,thumbnail}]（要位图，贵，只在采样点调）
  const capture = opts.capture;
  const rootDir = opts.dir;                           // 会话根目录
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  let session = null;
  let interval = START_INTERVAL;
  let lastKeptAt = 0;      // 上一次“真的留下帧”的时刻（安静收尾用）
  let lastTryAt = 0;       // 上一次“尝试抓图”的时刻（配速用）
  let lastFp = null;
  let seq = 0;
  let busy = false;

  /** 只留最近 KEEP_SESSIONS 场原帧，避免长期开着涨到几百 MB；还没送去分析的先留着 */
  function pruneOldSessions(keepId) {
    try {
      const names = fs.readdirSync(rootDir).filter((n) => /^w[0-9a-z]+$/.test(n));
      if (names.length <= KEEP_SESSIONS) return;
      names.sort();                                   // id 里带 36 进制时间戳，字典序≈时间序
      const drop = names.slice(0, Math.max(0, names.length - KEEP_SESSIONS));
      drop.forEach((n) => {
        if (n === keepId) return;
        // 还没分析过的会话（有 session.json）不能删，否则用户看完就白看了
        if (fs.existsSync(path.join(rootDir, n, 'session.json'))) return;
        try { fs.rmSync(path.join(rootDir, n), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
      });
    } catch (e) { /* 目录还不存在之类，忽略 */ }
  }

  /**
   * 会话收尾时把元数据落盘：进程被关掉、管家没开，下次也能补分析。
   * 注意：平时每存一帧也会调它（见 keepFrame）—— 这样突然关机/断电时，
   * 至少标题和已录帧还在，重启后能接着出报告，而不是变成「没记下标题的旧视频」。
   */
  function saveMeta(s) {
    try {
      const meta = {
        id: s.id,
        title: s.title,
        startedAt: s.startedAt,
        endedAt: s.endedAt,          // 还在录时是 0
        reason: s.reason || '',
        recording: !!s.active,       // 还在录 → true：补发时不能把它当成“看完了”
        frames: s.frames.map((f) => ({ i: f.i, file: f.file, at: f.at }))
      };
      fs.writeFileSync(path.join(s.dir, 'session.json'), JSON.stringify(meta), 'utf8');
    } catch (e) { /* 落盘失败不影响本次 */ }
  }

  function startSession(title, sourceId) {
    const id = 'w' + now().toString(36);
    const dir = path.join(rootDir, id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 忽略 */ }
    session = {
      id, dir, title, sourceId,
      startedAt: now(), endedAt: 0,
      active: true,             // 正在录（写进 meta 的 recording 字段）
      frames: [],               // [{ i, file, at, ai: base64 }]
      interval
    };
    lastKeptAt = 0;
    lastTryAt = 0;
    lastFp = null;
    seq = 0;
    pruneOldSessions(id);
    onEvent('start', session);
    return session;
  }

  function thinOut() {
    // 帧数封顶后：隔一张丢一张，间隔翻倍 —— 全片仍然均匀覆盖
    session.frames = session.frames.filter((f, i) => i % 2 === 0);
    session.interval = session.interval * 2;
    interval = session.interval;
    fs.readdir(session.dir, (err, files) => {
      if (err) return;
      const keep = new Set(session.frames.map((f) => path.basename(f.file)));
      files.forEach((f) => { if (!keep.has(f)) { try { fs.unlinkSync(path.join(session.dir, f)); } catch (e) { /* 忽略 */ } } });
    });
  }

  function keepFrame(img, at) {
    try {
      const n = ++seq;
      const file = path.join(session.dir, 'f' + String(n).padStart(3, '0') + '.jpg');
      fs.writeFileSync(file, img.resize({ width: FRAME_W, quality: 'good' }).toJPEG(72));
      let ai = '';
      try { ai = img.resize({ width: AI_W, quality: 'good' }).toJPEG(58).toString('base64'); } catch (e) { ai = ''; }
      session.frames.push({ i: n, file, at, ai });
      lastKeptAt = at;
      if (session.frames.length > MAX_FRAMES) thinOut();
      saveMeta(session);                 // 每帧落一次标题/帧表：断电关机也不至于变成“无名录像”
      onEvent('frame', session);
    } catch (err) { /* 单帧失败不影响会话 */ }
  }

  function endSession(reason) {
    if (!session) return null;
    const s = session;
    s.endedAt = now();
    s.reason = reason;
    s.active = false;
    session = null;
    interval = START_INTERVAL;
    lastFp = null;
    if (s.frames.length >= 2) {
      saveMeta(s);                       // 先落盘再发，发不出去也不会丢
      onEvent('end', s);
      return s;
    }
    // 帧太少（比如刚点开就关了）不打扰
    try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    onEvent('discard', s);
    return null;
  }

  async function tick() {
    if (busy) return { state: session ? 'recording' : 'idle', session };
    busy = true;
    try {
      // 第一段：只看窗口标题。不请求缩略图，几乎不花 CPU/内存。
      const list = await capture({ thumbnails: false });
      const hit = (list || []).find((s) => isVideoTitle(s.name));

      if (!hit) {
        if (session && now() - lastKeptAt > END_GONE_MS) endSession('gone');
        busy = false;
        return { state: session ? 'recording' : 'idle', session };
      }

      const title = cleanTitle(hit.name);

      // 换视频了：先把上一个收尾，再开新的
      if (session && title && session.title !== title) {
        endSession('switched');
        startSession(title, hit.id);
      } else if (!session) {
        startSession(title, hit.id);
      }

      // 超长视频兜底收尾（放在配速判断之前，否则不采样的拍子里永远查不到）
      if (session && now() - session.startedAt > MAX_SESSION_MS) {
        endSession('timeout');
        busy = false;
        return { state: 'idle', session: null };
      }

      // 没到采样点就到此为止 —— 这一拍连一张位图都不产生
      const due = !lastKeptAt || now() - lastTryAt >= interval;
      if (!due) {
        busy = false;
        return { state: 'recording', session };
      }
      lastTryAt = now();

      // 第二段：确实要一帧了，这时才付“抓缩略图”的钱
      const shots = await capture({ thumbnails: true, preferId: hit.id });
      const one = (shots || []).find((s) => s.id === hit.id)
        || (shots || []).find((s) => isVideoTitle(s.name));
      const img = one && one.thumbnail;

      if (img && !img.isEmpty()) {
        const fp = fingerprint(img);
        const moved = diff(fp, lastFp) > CHANGE_EPS;
        if (moved) lastFp = fp;

        if (moved) keepFrame(img, now());
        else if (now() - lastKeptAt > END_SILENT_MS) { endSession('silent'); }
      }
    } catch (err) {
      onEvent('error', err);
    }
    busy = false;
    return { state: session ? 'recording' : 'idle', session };
  }

  return {
    tick,
    stop: (reason) => endSession(reason || 'manual'),
    status: () => (session ? { id: session.id, title: session.title, frames: session.frames.length, startedAt: session.startedAt } : null)
  };
}

/* ---------- 磁盘上的待分析会话（管家没开、程序被关都不会丢） ---------- */

/**
 * 列出还没送去分析的会话，按时间从早到晚。
 * opts.includeOrphans：开机时传 true —— 把「正在录就被关机/断电」留下的场次认领成
 * 已结束（reason='orphan'），否则它们的 recording=true 会永远被跳过。
 * 平时补发一律不传，正在录的那一场绝不能被当成“看完了”提前送出去。
 */
function listPendingSessions(rootDir, opts) {
  const includeOrphans = !!(opts && opts.includeOrphans);
  try {
    return fs.readdirSync(rootDir)
      .filter((n) => /^w[0-9a-z]+$/.test(n))
      .map((n) => {
        const file = path.join(rootDir, n, 'session.json');
        try {
          const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!meta || !Array.isArray(meta.frames) || meta.frames.length < 2) return null;
          if (meta.recording) {
            if (!includeOrphans) return null;              // 还在录，别抢跑
            // 孤儿场次：进程被关掉了，按最后一帧时间收尾，并补写回磁盘
            const last = meta.frames[meta.frames.length - 1];
            meta.recording = false;
            meta.endedAt = (last && last.at) || meta.endedAt || 0;
            meta.reason = meta.reason || 'orphan';
            try { fs.writeFileSync(file, JSON.stringify(meta), 'utf8'); } catch (e) { /* 忽略 */ }
          }
          meta.dir = path.join(rootDir, n);
          return meta;
        } catch (e) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  } catch (e) {
    return [];
  }
}

/**
 * 记一次「送出去但没等到结果」。
 * 用途：网页要是没接住（没开、崩了、模型报错），这场不能被当成已发送而永久丢掉；
 * 记满 MAX_TRIES 次才认命，免得一个坏视频无限烧 token。
 */
const MAX_TRIES = 3;
function noteSessionAttempt(rootDir, id) {
  try {
    const file = path.join(rootDir, id, 'session.json');
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    meta.attempts = (meta.attempts || 0) + 1;
    fs.writeFileSync(file, JSON.stringify(meta), 'utf8');
    return meta.attempts;
  } catch (e) {
    return MAX_TRIES;
  }
}

/** 已经发出去了：改名成 session.sent.json，下次不重复发 */
function markSessionSent(rootDir, id) {
  try {
    const dir = path.join(rootDir, id);
    const from = path.join(dir, 'session.json');
    if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, 'session.sent.json'));
  } catch (e) { /* 忽略 */ }
}

/** 报告已经生成：整场素材可以删了 */
function dropSession(rootDir, id) {
  try { fs.rmSync(path.join(rootDir, id), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

/**
 * 认领「老版本录下来的」会话：那时候只存了 jpg，没写 session.json，
 * 所以旧录像一直躺在那儿没人分析。这里按帧文件倒推出会话，让它们能补上。
 * 只认领最近 limit 场，避免一次把几年的都翻出来烧 token。
 */
function adoptLegacySessions(rootDir, limit) {
  const cap = limit || 3;
  let adopted = 0;
  let names = [];
  try { names = fs.readdirSync(rootDir).filter((n) => /^w[0-9a-z]+$/.test(n)).sort().reverse(); } catch (e) { return 0; }
  for (const n of names) {
    if (adopted >= cap) break;
    const dir = path.join(rootDir, n);
    if (fs.existsSync(path.join(dir, 'session.json'))) continue;
    if (fs.existsSync(path.join(dir, 'session.sent.json'))) continue;
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^f\d+\.jpg$/i.test(f)).sort(); } catch (e) { continue; }
    if (files.length < 2) continue;
    const frames = files.map((f, i) => {
      const file = path.join(dir, f);
      let at = 0;
      try { at = Math.round(fs.statSync(file).mtimeMs); } catch (e) { /* 拿不到时间就算了 */ }
      return { i: i + 1, file, at };
    });
    const meta = {
      id: n,
      title: '没记下标题的旧视频',
      startedAt: frames[0].at || Date.now(),
      endedAt: frames[frames.length - 1].at || Date.now(),
      reason: 'adopted',
      legacy: true,
      frames
    };
    try {
      fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(meta), 'utf8');
      adopted += 1;
    } catch (e) { /* 忽略 */ }
  }
  return adopted;
}

module.exports = {
  createWatcher, cleanTitle, isVideoTitle, fingerprint, diff, safeName,
  MAX_FRAMES, MAX_TRIES, KEEP_SESSIONS, listPendingSessions, markSessionSent, dropSession,
  adoptLegacySessions, noteSessionAttempt
};
