// 从盲盒卡片图里把小人抠出来做成皮肤素材
//   node tools/make-skins.js
//
// 输入：D:/Downloads/workbuddy-<名字>-<id>.png（720x960 整卡：背景水印 + 小人 + 名字 + 二维码卡）
// 输出：pet-app/skins/<id>.png（只留小人、背景透明）
//
// 抠图思路：背景（连着水印文字）是从图像边缘连通的暗色区域 —— 从边缘 flood fill，
// 「和背景色够近就吞掉」；小人黑色的脸被亮的头盔包着，不与边缘连通，所以不会被误吞。
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SRC_DIR = 'D:/Downloads';
const OUT_DIR = path.join(__dirname, '..', 'pet-app', 'skins');

// 皮肤清单：id / 中文名 / 稀有度 / 主题色（机箱配色用）
const SKINS = [
  { id: 'pixel',    name: '像素喵',     rarity: 'R',  file: 'workbuddy-像素喵-1793464544417.png',     theme: '#57d97a' },
  { id: 'stellar',  name: '星际喵',     rarity: 'SR', file: 'workbuddy-星际喵-1793464535734.png',     theme: '#4da3ff' },
  { id: 'rich',     name: '暴富喵',     rarity: 'UR', file: 'workbuddy-暴富喵-1793464529114.png',     theme: '#e8b64c' },
  { id: 'camera',   name: '镜头喵',     rarity: 'R',  file: 'workbuddy-镜头喵-1793464520480.png',     theme: '#f5c542' },
  { id: 'pubg',     name: '和平精英喵', rarity: 'R',  file: 'workbuddy-和平精英喵-1793464509600.png', theme: '#37c8f0' }
];

const PAGE_HTML = '<!DOCTYPE html><html><body><canvas id="c"></canvas><script>' +
  'window.cutSkin = function(imgSrc) {' +
  '  return new Promise(function (resolve, reject) {' +
  '    const img = new Image();' +
  '    img.onload = function () {' +
  '      try { resolve(process(img)); } catch (e) { reject(e); }' +
  '    };' +
  '    img.onerror = function () { reject(new Error("img load fail")); };' +
  '    img.src = imgSrc;' +
  '  });' +
  '  function process(img) {' +
  '    const W = img.width, H = img.height;' +
  '    const c = document.createElement("canvas"); c.width = W; c.height = H;' +
  '    const ctx = c.getContext("2d", { willReadFrequently: true });' +
  '    ctx.drawImage(img, 0, 0);' +
  '    const img1 = ctx.getImageData(0, 0, W, H);' +
  '    const px = img1.data;' +
  // 背景基准：四角各 12x12 的平均色
  '    let br = 0, bg = 0, bb = 0, bn = 0;' +
  '    const corners = [[0, 0], [W - 12, 0], [0, H - 12], [W - 12, H - 12]];' +
  '    for (const [cx, cy] of corners) {' +
  '      for (let y = cy; y < cy + 12; y++) for (let x = cx; x < cx + 12; x++) {' +
  '        const i = (y * W + x) * 4; br += px[i]; bg += px[i + 1]; bb += px[i + 2]; bn++;' +
  '      }' +
  '    }' +
  '    br /= bn; bg /= bn; bb /= bn;' +
  '    const dist = (i) => {' +
  '      const dr = px[i] - br, dg = px[i + 1] - bg, db = px[i + 2] - bb;' +
  '      return Math.sqrt(dr * dr + dg * dg + db * db);' +
  '    };' +
  // 找小人的包围盒：色差明显的像素（只看卡片上半部，二维码卡在下面）
  '    let minX = W, minY = H, maxX = 0, maxY = 0;' +
  '    const BODY_T = 64;' +
  '    for (let y = 0; y < Math.min(H, 700); y++) {' +
  '      for (let x = 0; x < W; x++) {' +
  '        if (dist((y * W + x) * 4) > BODY_T) {' +
  '          if (x < minX) minX = x; if (x > maxX) maxX = x;' +
  '          if (y < minY) minY = y; if (y > maxY) maxY = y;' +
  '        }' +
  '      }' +
  '    }' +
  '    if (maxX <= minX) throw new Error("找不到小人");' +
  '    const pad = 30;' +
  '    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);' +
  '    maxX = Math.min(W - 1, maxX + pad); maxY = Math.min(H - 1, maxY + pad);' +
  '    const cw = maxX - minX + 1, ch = maxY - minY + 1;' +
  // 裁剪
  '    const c2 = document.createElement("canvas"); c2.width = cw; c2.height = ch;' +
  '    const ctx2 = c2.getContext("2d", { willReadFrequently: true });' +
  '    ctx2.drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch);' +
  '    const img2 = ctx2.getImageData(0, 0, cw, ch);' +
  '    const q = img2.data;' +
  // flood fill：从裁剪图边界开始吞背景
  '    const T1 = 34;      // 和背景色差小于它 → 直接透明' +
  '    const T2 = 88;      // 背景区旁边色差小于它 → 按距离软化（边缘不生硬）' +
  '    const n = cw * ch;' +
  '    const state = new Uint8Array(n);  // 0 未访问 1 背景抠掉 2 边缘软化' +
  '    const stack = new Int32Array(n);' +
  '    let sp = 0;' +
  '    const push = (p) => { if (!state[p]) { state[p] = 1; stack[sp++] = p; } };' +
  '    for (let x = 0; x < cw; x++) { push(x); push((ch - 1) * cw + x); }' +
  '    for (let y = 0; y < ch; y++) { push(y * cw); push(y * cw + cw - 1); }' +
  '    while (sp > 0) {' +
  '      const p = stack[--sp];' +
  '      const x = p % cw, y = (p / cw) | 0;' +
  '      const nb = [];' +
  '      if (x > 0) nb.push(p - 1); if (x < cw - 1) nb.push(p + 1);' +
  '      if (y > 0) nb.push(p - cw); if (y < ch - 1) nb.push(p + cw);' +
  '      for (const q2 of nb) {' +
  '        if (state[q2]) continue;' +
  '        if (dist(q2 * 4) < T1) push(q2);' +
  '      }' +
  '    }' +
  // 边缘软化：背景区旁边色差介于 T1~T2 的像素，alpha 按距离渐变
  '    for (let p = 0; p < n; p++) {' +
  '      if (state[p] !== 1) continue;' +
  '      const x = p % cw, y = (p / cw) | 0;' +
  '      const nb = [];' +
  '      if (x > 0) nb.push(p - 1); if (x < cw - 1) nb.push(p + 1);' +
  '      if (y > 0) nb.push(p - cw); if (y < ch - 1) nb.push(p + cw);' +
  '      for (const q2 of nb) {' +
  '        if (state[q2]) continue;' +
  '        const d = dist(q2 * 4);' +
  '        if (d < T2) {' +
  '          const a = Math.round(255 * Math.min(1, (d - T1) / (T2 - T1)));' +
  '          q[q2 * 4 + 3] = Math.min(q[q2 * 4 + 3], a);' +
  '          state[q2] = 2;' +
  '        }' +
  '      }' +
  '    }' +
  // 抠掉背景
  '    for (let p = 0; p < n; p++) if (state[p] === 1) q[p * 4 + 3] = 0;' +
  '    ctx2.putImageData(img2, 0, 0);' +
  '    return { dataUrl: c2.toDataURL("image/png"), w: cw, h: ch };' +
  '  }' +
  '};' +
  '</script></body></html>';

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 120)));
  await page.goto('file:///' + path.join(__dirname, 'skin-cutter.html').replace(/\\/g, '/'));

  const manifest = [];
  for (const s of SKINS) {
    // 以 dataURL 喂给浏览器：file:// 页面读 file:///D:/ 的图会污染 canvas（SecurityError）
    const b = fs.readFileSync(path.join(SRC_DIR, s.file));
    const src = 'data:image/png;base64,' + b.toString('base64');
    const r = await page.evaluate((src) => window.cutSkin(src), src);
    const b64 = r.dataUrl.split(',')[1];
    const out = path.join(OUT_DIR, s.id + '.png');
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    manifest.push(Object.assign({}, s, { w: r.w, h: r.h, out: path.basename(out) }));
    console.log('✓', s.name, '→', path.basename(out), r.w + 'x' + r.h,
      Math.round(fs.statSync(out).size / 1024) + ' KB');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'skins.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await browser.close();
  console.log('完成：' + manifest.length + ' 张皮肤 + skins.json');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
