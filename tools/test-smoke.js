// 全站冒烟：本地起服务，加载首页，检查资源 404 / 脚本报错 / 关键元素
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PASS = [], FAIL = [];
const ok = (c, m, e) => { (c ? PASS : FAIL).push(m + (e ? '  → ' + e : '')); console.log((c ? '  ok   ' : '  FAIL ') + m + (e ? '   ' + e : '')); };

function serve(port) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, u === '/' ? 'index.html' : u);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}

(async () => {
  const PORT = 8138;
  const srv = await serve(PORT);
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });

  const bad = [], errs = [];
  page.on('response', r => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url()); });
  page.on('pageerror', e => errs.push(String(e).slice(0, 120)));
  page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 120)); });

  await page.goto(`http://127.0.0.1:${PORT}/?sharecode=BRPXR3GO4G`, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  const info = await page.evaluate(() => {
    const need = ['boot', 'auth', 'app', 'phoneForm', 'wechatPane', 'wechatBtn', 'sendCode',
      'authTabs', 'view', 'nav', 'search', 'todoCount', 'side', 'drawer', 'toasts'];
    const missing = need.filter(id => !document.getElementById(id));
    return {
      missing,
      cloud: !!window.cloud,
      sdk: !!window.WorkBuddyCloud,
      cfg: !!(window.PUBLIC_CONFIG && window.PUBLIC_CONFIG.endpoint),
      pet: !!(window.Keeper && window.Keeper.pet),
      authVisible: !document.getElementById('auth').classList.contains('hidden')
    };
  });

  ok(info.sdk, '云 SDK 已加载');
  ok(info.cloud, 'cloud 客户端已初始化');
  ok(info.cfg, 'PUBLIC_CONFIG 已就位');
  ok(info.pet, '小机器人联动桥已挂载');
  ok(info.missing.length === 0, '关键 DOM 元素齐全', info.missing.join(',') || '');
  ok(info.authVisible, '未登录时展示登录界面');
  ok(bad.length === 0, '没有 404 / 5xx 资源', bad.slice(0, 3).join(' | ') || '');
  ok(errs.length === 0, '没有脚本报错', errs.slice(0, 2).join(' | ') || '');

  // 微信登录按钮在本地预览下应给出明确指引而不是发起授权
  await page.evaluate(() => document.querySelector('.auth-tab[data-method="wechat"]').click());
  await page.click('#wechatBtn');
  await new Promise(r => setTimeout(r, 400));
  const tip = await page.evaluate(() => (document.getElementById('wechatError') || {}).textContent || '');
  ok(/发布地址/.test(tip), '本地预览点微信登录会提示用发布地址', JSON.stringify(tip.slice(0, 40)));
  ok(page.url().indexOf('open.weixin.qq.com') < 0, '本地预览不会误跳微信');

  await browser.close();
  srv.close();
  console.log('\n通过 ' + PASS.length + ' 项，失败 ' + FAIL.length + ' 项');
  if (FAIL.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
