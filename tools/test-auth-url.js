// 微信登录地址链路自测
//   1) 直接跑 js/app.js 里的 shareCode / cleanUrl / oauthRedirectTo 源码，验证回调地址一定带分享码
//   2) 用真实浏览器 + 本地静态服务器，验证「带 code+state 的回调地址」不会再白屏/报错
// 用法： NODE_PATH=<managed node_modules> node tools/test-auth-url.js
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PASS = [], FAIL = [];
function ok(cond, msg, extra) {
  (cond ? PASS : FAIL).push(msg + (extra ? '  → ' + extra : ''));
  console.log((cond ? '  ok   ' : '  FAIL ') + msg + (extra ? '   ' + extra : ''));
}

/* ── 从源文件里抠出函数，保证测的是线上同一段逻辑 ── */
function grabFn(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('找不到 function ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error('解析失败 ' + name);
}

function buildAuthFns(locationObj, publicConfig) {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  const body = ['shareCode', 'cleanUrl', 'oauthRedirectTo', 'wechatErrorText']
    .map(n => grabFn(src, n)).join('\n');
  const factory = new Function('location', 'window', body + '\nreturn { shareCode, cleanUrl, oauthRedirectTo, wechatErrorText };');
  return factory(locationObj, { PUBLIC_CONFIG: publicConfig });
}

const PUB = {
  publishedUrl: 'https://your-app-id.app.workbuddy.host/?sharecode=YOUR_SHARECODE'
};

function testUrls() {
  console.log('\n[1] 回调地址是否带分享码');

  // 场景 A：从中转站回来，地址上有 code/state/sharecode
  let f = buildAuthFns(
    { origin: 'https://your-app-id.app.workbuddy.host', pathname: '/', search: '?code=abc&provider=wechat&sharecode=YOUR_SHARECODE&state=def' },
    PUB
  );
  ok(f.shareCode() === 'YOUR_SHARECODE', 'A 能从回调地址里取到分享码', f.shareCode());
  ok(f.cleanUrl() === '/?sharecode=YOUR_SHARECODE', 'A 登录后地址只留分享码（去掉 code/state）', f.cleanUrl());
  ok(f.oauthRedirectTo() === 'https://your-app-id.app.workbuddy.host/?sharecode=YOUR_SHARECODE',
    'A 回调地址带 sharecode（关键修复）', f.oauthRedirectTo());

  // 场景 B：地址上暂时没有分享码（例如被手工清掉了），要从发布配置里补
  f = buildAuthFns(
    { origin: 'https://your-app-id.app.workbuddy.host', pathname: '/', search: '' },
    PUB
  );
  ok(f.shareCode() === 'YOUR_SHARECODE', 'B 地址没分享码时回退到发布配置', f.shareCode());
  ok(f.oauthRedirectTo().indexOf('sharecode=YOUR_SHARECODE') > 0, 'B 回调地址照样带分享码', f.oauthRedirectTo());

  // 场景 C：没有发布配置、地址也没有 → 退化为 origin（不抛异常）
  f = buildAuthFns({ origin: 'http://localhost:8099', pathname: '/', search: '' }, {});
  ok(f.oauthRedirectTo() === 'http://localhost:8099/', 'C 极端情况不崩', f.oauthRedirectTo());

  // 场景 D：错误文案
  f = buildAuthFns({ origin: 'https://x', pathname: '/', search: '' }, PUB);
  const t1 = f.wechatErrorText('invalid or expired oauth callback');
  ok(/超时/.test(t1) && /重新/.test(t1), 'D 过期错误有中文可读提示', t1);
  const t2 = f.wechatErrorText('');
  ok(/重试/.test(t2), 'D 空错误有兜底文案', t2);
}

/* ── 真实浏览器：回调落地页 ── */
function serve(port) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(ROOT, u === '/' ? 'index.html' : u);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}

async function testLanding() {
  console.log('\n[2] 回调落地页（真实浏览器 + 本地服务器）');
  const PORT = 8137;
  const srv = await serve(PORT);
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));

  const cases = [
    ['带 sharecode 的回调地址', `http://127.0.0.1:${PORT}/?code=bogus&provider=wechat&sharecode=YOUR_SHARECODE&state=bogus`],
    ['普通打开', `http://127.0.0.1:${PORT}/?sharecode=YOUR_SHARECODE`]
  ];
  for (const [label, url] of cases) {
    await page.goto(url, { waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 2500));
    const info = await page.evaluate(() => ({
      authVisible: !document.getElementById('auth').classList.contains('hidden'),
      bootHidden: document.getElementById('boot') ? document.getElementById('boot').classList.contains('hidden') : true,
      wechatErr: (document.getElementById('wechatError') || {}).textContent || '',
      bodyLen: document.body.innerText.replace(/\s/g, '').length
    }));
    ok(info.authVisible && info.bodyLen > 50, label + ' 正常渲染出登录界面（没白屏）',
      'body ' + info.bodyLen + ' 字');
    if (label.indexOf('回调') === 0) {
      ok(!/undefined|\[object/.test(info.wechatErr), '回调失败时的提示文案正常', JSON.stringify(info.wechatErr.slice(0, 60)));
      ok(/微信登录/.test(info.wechatErr), '回调失败有明确的微信提示', JSON.stringify(info.wechatErr.slice(0, 60)));
    }
  }
  ok(errs.length === 0, '无脚本报错', errs.slice(0, 2).join(' | ') || '');
  await browser.close();
  srv.close();
}

(async () => {
  testUrls();
  await testLanding();
  console.log('\n通过 ' + PASS.length + ' 项，失败 ' + FAIL.length + ' 项');
  if (FAIL.length) { FAIL.forEach(f => console.log('  × ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
