// 陪看产物：一份 .pptx 报告（可投屏、可编辑）。
//
// 用 pptxgenjs 直接生成，纯 Node，不依赖浏览器渲染 —— 少一层截图、少一个隐藏窗口，
// 生成的也慢不到哪里去，还不用担心「隐藏窗口截不到图」这类玄学问题。
'use strict';

const fs = require('fs');
const path = require('path');

const INK = '#0f1614';
const PAPER = '#f4f7f5';
const ACCENT = '#2fbf8f';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function asList(v, max) {
  const arr = Array.isArray(v) ? v.filter((x) => x != null && String(x).trim()) : [];
  return arr.slice(0, max || 6).map((x) => String(x).trim());
}

function normalize(analysis) {
  const a = analysis || {};
  let rating = Number(a.rating);
  if (!isFinite(rating)) rating = 0;
  rating = Math.max(0, Math.min(10, rating));
  return {
    verdict: String(a.verdict || '这段视频值得看，但需要快进。').trim(),
    points: asList(a.points, 6),
    highlights: asList(a.highlights, 4),
    flaws: asList(a.flaws, 4),
    tags: asList(a.tags, 8),
    audience: String(a.audience || '').trim(),
    rating
  };
}

function dataUri(file, mime) {
  try {
    const buf = fs.readFileSync(file);
    const m = mime || (/\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg');
    return 'data:' + m + ';base64,' + buf.toString('base64');
  } catch (err) { return ''; }
}

/** 挑几张有代表性的帧：均匀取 4 张 */
function pickFrames(frames, n) {
  const list = (frames || []).filter((f) => f && f.file);
  if (!list.length) return [];
  const out = [];
  const step = Math.max(1, Math.floor(list.length / n));
  for (let i = 0; i < list.length && out.length < n; i += step) out.push(list[i]);
  return out;
}

/* ---------------- B 站信息（认出视频时才有） ---------------- */

function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + ' 亿';
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
  return String(v);
}

/** 秒 → 04:10 这种快手能认的写法 */
function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

/** 从会话里抽出能给报告加分的 B 站信息；没有就返回 null（报告照旧出） */
function biliBits(session) {
  const b = session && session.bili;
  if (!b || !b.ok || !b.info) return null;
  const i = b.info;
  const d = b.danmaku || null;
  const peak = (d && d.peaks && d.peaks[0]) || null;
  return {
    bvid: b.bvid || i.bvid || '',
    owner: i.owner || '',
    tname: i.tname || '',
    view: (i.stat && i.stat.view) || 0,
    danmaku: (d && d.total) || (i.stat && i.stat.danmaku) || 0,
    peak,
    samples: (d && d.samples) || []
  };
}

/** 一行「B 站来源」，封面用 */
function biliLine(b) {
  if (!b) return '';
  const bits = [];
  if (b.owner) bits.push('UP 主 ' + b.owner);
  if (b.tname) bits.push(b.tname);
  if (b.view) bits.push('播放 ' + fmtCount(b.view));
  if (b.danmaku) bits.push('弹幕 ' + fmtCount(b.danmaku));
  return bits.join(' · ');
}

/* ---------------- PPT ---------------- */

function buildPptx(session, analysis, outFile) {
  const PptxGenJS = require('pptxgenjs');
  const a = normalize(analysis);
  const frames = pickFrames(session && session.frames, 4);
  const title = (session && session.title) || 'B 站视频';
  const when = new Date((session && session.startedAt) || Date.now());
  const dateStr = when.getFullYear() + '-' + String(when.getMonth() + 1).padStart(2, '0') + '-' + String(when.getDate()).padStart(2, '0');

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = '信息管家 · 桌面小机器人';
  pptx.title = title;

  const FONT = 'Microsoft YaHei';
  const bg = (slide, color) => { slide.background = { color: color || '0F1614' }; };
  const head = (slide, text) => {
    slide.addText(text, { x: 0.55, y: 0.42, w: 8.9, h: 0.4, fontSize: 15, color: '6F877E', fontFace: FONT, charSpacing: 3 });
  };

  // 1 封面
  const s1 = pptx.addSlide();
  bg(s1);
  if (frames[0]) {
    const d = dataUri(frames[0].file);
    if (d) s1.addImage({ data: d, x: 5.35, y: 0, w: 4.65, h: 5.63, sizing: { type: 'cover', w: 4.65, h: 5.63 } });
  }
  s1.addShape(pptx.ShapeType.rect, { x: 5.1, y: 0, w: 0.9, h: 5.63, fill: { color: '0F1614', transparency: 0 } });
  s1.addText('小机器人陪看', { x: 0.55, y: 0.6, w: 4, h: 0.4, fontSize: 13, color: '2FBF8F', fontFace: FONT, charSpacing: 3 });
  s1.addText(title, { x: 0.55, y: 1.15, w: 4.6, h: 2.2, fontSize: 30, bold: true, color: 'F4F7F5', fontFace: FONT, lineSpacing: 40, valign: 'top' });
  s1.addText(a.rating ? a.rating.toFixed(1) : '—', { x: 0.55, y: 3.55, w: 2, h: 1.1, fontSize: 60, bold: true, color: '2FBF8F', fontFace: FONT });
  s1.addText('推荐指数 / 10', { x: 0.62, y: 4.62, w: 2.4, h: 0.35, fontSize: 12, color: '6F877E', fontFace: FONT });
  s1.addText(dateStr, { x: 0.55, y: 4.95, w: 3, h: 0.3, fontSize: 11, color: '6F877E', fontFace: FONT });
  const bili = biliBits(session);
  if (bili) {
    const bits = [bili.owner ? 'UP 主 ' + bili.owner : '', bili.view ? '播放 ' + fmtCount(bili.view) : '',
      bili.danmaku ? '弹幕 ' + fmtCount(bili.danmaku) : '', bili.bvid].filter(Boolean).join('  ·  ');
    s1.addText(bits, { x: 0.55, y: 5.2, w: 4.6, h: 0.3, fontSize: 10, color: '8FA79E', fontFace: FONT });
  }

  // 2 一句话观点
  const s2 = pptx.addSlide();
  bg(s2, '121B18');
  head(s2, '一句话观点');
  s2.addText(a.verdict, { x: 0.55, y: 1.15, w: 8.9, h: 2.4, fontSize: 26, bold: true, color: 'F4F7F5', fontFace: FONT, lineSpacing: 44, valign: 'top' });
  if (frames[1]) {
    const d = dataUri(frames[1].file);
    if (d) s2.addImage({ data: d, x: 0.55, y: 3.75, w: 3.0, h: 1.65, sizing: { type: 'cover', w: 3.0, h: 1.65 } });
  }

  // 3 要点
  const s3 = pptx.addSlide();
  bg(s3);
  head(s3, '它讲了什么');
  const pts = a.points.length ? a.points : ['（这次没取到要点）'];
  s3.addText(pts.map((p, i) => ({
    text: p,
    options: { bullet: { code: '25AA' }, fontSize: 17, color: 'E6EEEA', breakLine: true, paraSpaceAfter: 12, indentLevel: 0, numberingStart: i + 1 }
  })), { x: 0.7, y: 1.15, w: 8.6, h: 3.9, fontFace: FONT, lineSpacing: 30, valign: 'top' });

  // 4 亮点 / 槽点
  const s4 = pptx.addSlide();
  bg(s4, '121B18');
  head(s4, '值得看 vs 可以跳过');
  s4.addShape(pptx.ShapeType.roundRect, { x: 0.55, y: 1.05, w: 4.35, h: 3.9, fill: { color: '16241F' }, line: { color: '2FBF8F', width: 1 }, rectRadius: 0.08 });
  s4.addShape(pptx.ShapeType.roundRect, { x: 5.1, y: 1.05, w: 4.35, h: 3.9, fill: { color: '221715' }, line: { color: 'E0795F', width: 1 }, rectRadius: 0.08 });
  s4.addText('值得看的地方', { x: 0.8, y: 1.25, w: 4, h: 0.35, fontSize: 13, bold: true, color: '2FBF8F', fontFace: FONT });
  s4.addText((a.highlights.length ? a.highlights : ['暂无']).map((x) => ({ text: '· ' + x, options: { breakLine: true, paraSpaceAfter: 10 } })),
    { x: 0.8, y: 1.7, w: 3.85, h: 3.0, fontSize: 15, color: 'E6EEEA', fontFace: FONT, lineSpacing: 26, valign: 'top' });
  s4.addText('可以跳过的地方', { x: 5.35, y: 1.25, w: 4, h: 0.35, fontSize: 13, bold: true, color: 'E0795F', fontFace: FONT });
  s4.addText((a.flaws.length ? a.flaws : ['暂无']).map((x) => ({ text: '· ' + x, options: { breakLine: true, paraSpaceAfter: 10 } })),
    { x: 5.35, y: 1.7, w: 3.85, h: 3.0, fontSize: 15, color: 'E6EEEA', fontFace: FONT, lineSpacing: 26, valign: 'top' });

  // 5 弹幕现场（认出了 B 站视频才有）
  if (bili && bili.samples.length) {
    const sd = pptx.addSlide();
    bg(sd, '121B18');
    head(sd, '弹幕里在说什么' + (bili.peak ? '　·　最热闹 ' + mmss(bili.peak.from) + '–' + mmss(bili.peak.to) + '（' + bili.peak.count + ' 条）' : ''));
    const rows = bili.samples.slice(0, 6).map((t) => '「' + t + '」').join('     ');
    sd.addText(rows, {
      x: 0.6, y: 1.15, w: 8.8, h: 3.2, fontSize: 18, color: 'E6EEEA', fontFace: FONT,
      lineSpacing: 34, valign: 'top'
    });
    sd.addText('共 ' + fmtCount(bili.danmaku) + ' 条弹幕 · 抽样展示，代表观众的真实反应', {
      x: 0.6, y: 4.55, w: 8.8, h: 0.4, fontSize: 12, color: '6F877E', fontFace: FONT
    });
  }

  // 6 适合谁看
  const s5 = pptx.addSlide();
  bg(s5);
  head(s5, '适合谁看');
  s5.addText(a.audience || '看过的人各有各的判断，这里只给一个参考。', {
    x: 0.55, y: 1.1, w: 8.9, h: 1.6, fontSize: 22, color: 'F4F7F5', fontFace: FONT, lineSpacing: 38, valign: 'top'
  });
  if (a.tags.length) {
    s5.addText(a.tags.map((t) => '#' + t).join('   '), { x: 0.55, y: 2.9, w: 8.9, h: 0.5, fontSize: 16, color: '2FBF8F', fontFace: FONT });
  }

  // 7 截图墙
  const s6 = pptx.addSlide();
  bg(s6, '0A100F');
  head(s6, '画面摘录');
  frames.slice(0, 4).forEach((f, i) => {
    const d = dataUri(f.file);
    if (!d) return;
    const x = 0.55 + (i % 2) * 4.55;
    const y = 1.0 + Math.floor(i / 2) * 2.2;
    s6.addImage({ data: d, x, y, w: 4.2, h: 2.0, sizing: { type: 'cover', w: 4.2, h: 2.0 } });
  });

  return pptx.writeFile({ fileName: outFile }).then(() => outFile);
}

/* ---------------- 对外 ---------------- */

/**
 * 生成一份 PPT 报告，返回文件路径。
 * 长图那套（隐藏窗口渲染 HTML 再截图）已经按用户要求整体移除，只留 PPT。
 */
async function buildReport(session, analysis, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const base = uniqueBase(outDir, datedBase(session));
  const pptx = path.join(outDir, base + '.pptx');
  const out = { pptx: '', dir: outDir };
  try { out.pptx = await buildPptx(session, analysis, pptx); } catch (err) { out.pptxError = err.message; }
  return out;
}

/** 文件名带日期，报告文件夹里天然按时间排序：2026-10-31-《朋克版ITX电脑》 */
function datedBase(session) {
  const when = new Date((session && session.startedAt) || Date.now());
  const d = when.getFullYear() + '-' + String(when.getMonth() + 1).padStart(2, '0') + '-' + String(when.getDate()).padStart(2, '0');
  return d + '-' + safeTitle(session && session.title);
}

/** 同名（同一天看了同名视频）就加 -2、-3，别把上一份覆盖掉 */
function uniqueBase(outDir, base) {
  let name = base;
  for (let i = 2; i < 50; i++) {
    const f = path.join(outDir, name + '.pptx');
    if (!fs.existsSync(f)) return name;
    name = base + '-' + i;
  }
  return base + '-' + Date.now();
}

function safeTitle(t) {
  return String(t || 'video').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'video';
}

module.exports = {
  buildReport, buildPptx, normalize, safeTitle, esc, dataUri,
  biliBits, biliLine, fmtCount, mmss, datedBase, uniqueBase
};
