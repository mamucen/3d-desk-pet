// B 站数据接入：从「窗口标题」反查到视频，再拿详情 / 弹幕 /（有登录态时）字幕。
//
// 为什么值得：靠截图给模型看，画面糊、信息少、还烧 token；
// 直接拿标题 + UP 主 + 时长 + 简介 + 弹幕，模型对「这视频在讲什么」的判断准得多。
//
// 接口都是 B 站公开的 web 接口，不需要账号也不需要密钥，下载即用：
//  - wbi 签名：/x/web-interface/nav 匿名取 img_key/sub_key，按混淆表拼 mixinKey，
//    参数排序后 md5(query + mixinKey) 作为 w_rid（密钥 B 站会轮换，所以每次运行时取，不写死）。
//  - 匿名设备 Cookie：先调 finger/spi 拿 buvid3/buvid4 挂在请求头上，
//    否则部分网络环境下搜索/弹幕会被 412 风控。拿到 412 时自动换一个 buvid 重试一次。
'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com' };
const TIMEOUT = 8000;

// B 站前端固定的混淆表
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
];

let keyCache = { value: '', at: 0 };
let cookieCache = { value: '', at: 0 };

/** 匿名设备 Cookie：buvid3/buvid4 不用登录，finger/spi 白给，缓存 24h。
 *  没有它，部分网络（尤其新机器/新 IP）第一次搜索就会吃 412。 */
async function anonCookie(force) {
  if (!force && cookieCache.value && Date.now() - cookieCache.at < 24 * 3600e3) return cookieCache.value;
  try {
    const j = await getJson('https://api.bilibili.com/x/frontend/finger/spi');
    const b3 = j && j.data && j.data.b_3;
    const b4 = j && j.data && j.data.b_4;
    if (b3) cookieCache = { value: 'buvid3=' + b3 + (b4 ? '; buvid4=' + b4 : ''), at: Date.now() };
  } catch (e) { /* 拿不到就裸奔，多数网络仍然能用 */ }
  return cookieCache.value;
}

function headersWithCookie() {
  const c = cookieCache.value;
  return c ? Object.assign({}, HEADERS, { Cookie: c }) : HEADERS;
}

async function getJson(url) {
  const res = await fetch(url, { headers: headersWithCookie(), signal: AbortSignal.timeout(TIMEOUT) });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return { code: res.status, message: 'not-json', raw: text.slice(0, 120) };
  }
}

function encParams(params) {
  return Object.keys(params).sort().map((k) => {
    const v = String(params[k]).replace(/[!'()*]/g, '');
    return encodeURIComponent(k) + '=' + encodeURIComponent(v);
  }).join('&');
}

/** wbi 签名用到的 mixinKey，nav 接口不用登录也能拿到，缓存半小时 */
async function mixinKey() {
  if (keyCache.value && Date.now() - keyCache.at < 30 * 60000) return keyCache.value;
  const nav = await getJson('https://api.bilibili.com/x/web-interface/nav');
  const img = (nav && nav.data && nav.data.wbi_img) || {};
  const pick = (u) => String(u || '').split('/').pop().split('.')[0];
  const raw = pick(img.img_url) + pick(img.sub_url);
  if (raw.length < 64) return '';
  const key = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
  keyCache = { value: key, at: Date.now() };
  return key;
}

async function signedGet(path, params) {
  await anonCookie();
  const mk = await mixinKey();
  const p = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const q = encParams(p);
  const rid = crypto.createHash('md5').update(q + mk).digest('hex');
  return getJson('https://api.bilibili.com' + path + '?' + q + '&w_rid=' + rid);
}

/** 去掉标点/括号/空格，方便比标题 */
function normalizeTitle(s) {
  return String(s || '')
    .replace(/[《》【】\[\]（）()「」『』“”"'’‘·、，,。.！!？?：:；;\-—_~～|/\\+*=#@&%$^]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 最长公共子串长度，衡量「搜索结果像不像我要的」 */
function commonLen(a, b) {
  if (!a || !b) return 0;
  const n = a.length, m = b.length;
  if (n * m > 40000) return 0;                      // 太长就别算了，避免卡住
  let best = 0;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/** 标题 → BV 号。找不到足够像的就返回空（宁可不猜，也别拿错视频）。
 *  吃到 412 风控时换一个新 buvid 重试一次 —— 新装机器最容易碰上。 */
async function resolveItem(title) {
  const q = String(title || '').trim();
  if (q.length < 4) return null;

  async function searchOnce() {
    return signedGet('/x/web-interface/wbi/search/type', {
      search_type: 'video', keyword: q, page: 1, page_size: 10
    });
  }

  let j = null;
  try { j = await searchOnce(); } catch (e) { return null; }
  if (j && (j.code === -412 || j.code === 412)) {
    cookieCache = { value: '', at: 0 };                    // 强制换 buvid
    await anonCookie(true);
    try { j = await searchOnce(); } catch (e) { return null; }
  }
  const list = (j && j.data && j.data.result) || [];
  if (!list.length) return null;
  const want = normalizeTitle(q);
  let best = null;
  let bestScore = 0;
  list.forEach((v) => {
    const got = normalizeTitle(String(v.title || '').replace(/<[^>]+>/g, ''));
    if (!got) return;
    const c = commonLen(want, got);
    const score = c / Math.max(want.length, Math.min(got.length, want.length + 6));
    if (score > bestScore) { bestScore = score; best = v; }
  });
  // 相似度门槛：低于 0.5 基本就是搜到别的视频了
  if (!best || bestScore < 0.5) return null;
  return { bvid: best.bvid || '', item: best, score: bestScore };
}

async function resolveBvid(title) {
  const hit = await resolveItem(title);
  return (hit && hit.bvid) || '';
}

/** "3:37" / "1:02:33" / 227 → 秒 */
function toSeconds(v) {
  if (v == null) return 0;
  const s = String(v);
  if (s.indexOf(':') < 0) return Math.round(Number(s) || 0);
  return s.split(':').reduce((acc, p) => acc * 60 + (Number(p) || 0), 0);
}

/**
 * 视频基本信息和第一 P 的 cid。
 * 普通 /view 接口最近经常直接吐 HTML（风控），所以走签名版的 /wbi/view，不行再退回普通的。
 */
async function videoInfo(bvid) {
  let j = null;
  try {
    j = await signedGet('/x/web-interface/wbi/view', { bvid });
  } catch (e) { /* 退回普通接口 */ }
  if (!j || j.code !== 0 || !j.data) {
    try { j = await getJson('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid)); } catch (e) { return null; }
  }
  if (!j || j.code !== 0 || !j.data) return null;
  const d = j.data;
  const page = (d.pages && d.pages[0]) || {};
  return {
    bvid: d.bvid,
    aid: d.aid,
    cid: page.cid || d.cid,
    title: d.title,
    owner: (d.owner && d.owner.name) || '',
    duration: d.duration || page.duration || 0,
    pubdate: d.pubdate || 0,
    desc: String(d.desc || ''),
    tname: d.tname || '',
    stat: {
      view: (d.stat && d.stat.view) || 0,
      danmaku: (d.stat && d.stat.danmaku) || 0,
      like: (d.stat && d.stat.like) || 0,
      reply: (d.stat && d.stat.reply) || 0
    }
  };
}

/** 详情接口整个挂掉时，用搜索结果里的字段拼一个「够用」的 info（没有 cid，所以没弹幕） */
function infoFromSearch(item, bvid) {
  if (!item) return null;
  const title = String(item.title || '').replace(/<[^>]+>/g, '').trim();
  if (!title) return null;
  return {
    bvid: item.bvid || bvid || '',
    aid: item.aid || 0,
    cid: 0,
    title,
    owner: item.author || item.uname || '',
    duration: toSeconds(item.duration),
    pubdate: item.pubdate || 0,
    desc: String(item.description || item.desc || ''),
    tname: item.typename || '',
    stat: {
      view: Number(item.play) || 0,
      danmaku: Number(item.danmaku) || Number(item.video_review) || 0,
      like: Number(item.like) || 0,
      reply: Number(item.review) || 0
    },
    partial: true
  };
}

/** 弹幕：解 deflate 的 XML，返回总条数、最热闹的时间段、均匀抽样的文本 */
async function danmaku(cid, maxSamples) {
  if (!cid) return null;
  await anonCookie();
  let buf;
  try {
    const res = await fetch('https://api.bilibili.com/x/v1/dm/list.so?oid=' + cid, {
      headers: headersWithCookie(), signal: AbortSignal.timeout(TIMEOUT)
    });
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return null;
  }
  let xml = '';
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
    try { xml = fn(buf).toString('utf8'); break; } catch (e) { /* 换下一种 */ }
  }
  if (!xml) { try { xml = buf.toString('utf8'); } catch (e) { return null; } }

  const rows = [];
  const re = /<d p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(xml))) {
    const at = parseFloat(String(m[1]).split(',')[0]);
    const text = String(m[2]).replace(/<[^>]*>/g, '').trim();
    if (text && isFinite(at)) rows.push({ at, text });
  }
  if (!rows.length) return { total: 0, peaks: [], samples: [] };

  rows.sort((a, b) => a.at - b.at);
  const span = Math.max(1, rows[rows.length - 1].at);
  const buckets = new Array(10).fill(0);
  rows.forEach((r) => {
    const i = Math.min(9, Math.floor((r.at / span) * 10));
    buckets[i] += 1;
  });
  const peakIdx = buckets.indexOf(Math.max.apply(null, buckets));
  const peaks = [{
    from: Math.round((peakIdx / 10) * span),
    to: Math.round(((peakIdx + 1) / 10) * span),
    count: buckets[peakIdx]
  }];

  // 均匀抽样，别把几千条都怼给模型
  const cap = maxSamples || 40;
  const step = Math.max(1, Math.floor(rows.length / cap));
  const samples = [];
  for (let i = 0; i < rows.length && samples.length < cap; i += step) samples.push(rows[i].text);

  return { total: rows.length, duration: Math.round(span), peaks, samples };
}

/** 字幕：需要登录态才给；拿不到就返回空，不影响其它信息 */
async function subtitle(info) {
  if (!info || !info.cid || !info.aid) return '';
  try {
    const j = await signedGet('/x/player/wbi/v2', { aid: info.aid, cid: info.cid, bvid: info.bvid });
    const list = (j && j.data && j.data.subtitle && j.data.subtitle.subtitles) || [];
    if (!list.length) return '';
    const target = list.find((s) => /zh|ai-zh/i.test(s.lan || '')) || list[0];
    const url = target && target.subtitle_url;
    if (!url) return '';
    const body = await getJson(url.indexOf('//') === 0 ? 'https:' + url : url);
    const items = (body && body.body) || [];
    return items.map((x) => String(x.content || '').trim()).filter(Boolean).join(' ').slice(0, 9000);
  } catch (e) {
    return '';
  }
}

/**
 * 一站式：标题 → 视频详情 + 弹幕（+ 字幕）。
 * 任何一步失败都不抛异常，只是字段缺失 —— 陪看不能因为 B 站抽风就整个失败。
 */
async function enrich(title, opts) {
  const o = opts || {};
  const out = { ok: false, bvid: '', info: null, danmaku: null, subtitle: '' };
  try {
    const hit = await resolveItem(title);
    if (!hit || !hit.bvid) return out;
    const bvid = hit.bvid;
    out.bvid = bvid;
    let info = await videoInfo(bvid);
    // 详情接口最近常被风控吐 HTML：用搜索项拼一个够用的版本，至少标题/UP主/播放数还在
    if (!info) info = infoFromSearch(hit.item, bvid);
    if (!info) return out;
    out.info = info;
    out.ok = true;
    if (o.danmaku !== false && info.cid) {
      try { out.danmaku = await danmaku(info.cid, o.maxSamples || 40); } catch (e) { /* 忽略 */ }
    }
    if (o.subtitle && info.cid) {
      try { out.subtitle = await subtitle(info); } catch (e) { /* 忽略 */ }
    }
  } catch (e) {
    /* 整个失败就当没用上 */
  }
  return out;
}

/** 给模型看的一段紧凑文本 */
function toPromptText(b) {
  if (!b || !b.ok || !b.info) return '';
  const i = b.info;
  const lines = [];
  lines.push('【B 站视频信息】');
  lines.push('标题：' + i.title);
  if (i.owner) lines.push('UP 主：' + i.owner);
  if (i.duration) lines.push('时长：' + Math.round(i.duration / 60) + ' 分钟');
  if (i.tname) lines.push('分区：' + i.tname);
  lines.push('数据：播放 ' + i.stat.view + ' · 弹幕 ' + i.stat.danmaku + ' · 点赞 ' + i.stat.like + ' · 评论 ' + i.stat.reply);
  if (i.desc) lines.push('简介：' + i.desc.replace(/\s+/g, ' ').slice(0, 300));
  if (b.danmaku && b.danmaku.total) {
    const d = b.danmaku;
    const peak = d.peaks && d.peaks[0];
    lines.push('弹幕共 ' + d.total + ' 条' + (peak
      ? '，最热闹的是第 ' + peak.from + '~' + peak.to + ' 秒（' + peak.count + ' 条）'
      : ''));
    if (d.samples.length) lines.push('弹幕抽样（按时间顺序）：' + d.samples.join(' / '));
  }
  if (b.subtitle) lines.push('字幕节选：' + b.subtitle.slice(0, 2500));
  return lines.join('\n');
}

module.exports = {
  enrich, toPromptText, resolveBvid, resolveItem, videoInfo, infoFromSearch, toSeconds,
  danmaku, subtitle, normalizeTitle, commonLen, signedGet, mixinKey, anonCookie
};
