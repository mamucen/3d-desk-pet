// 线上验证：微信登录授权请求里的 callback_url 必须带 sharecode；回调落地页必须能打开
'use strict';
const https = require('https');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'https://info-keeper-21227.app.workbuddy.host';
const SHARE = '?sharecode=BRPXR3GO4G';
const PASS = [], FAIL = [];
const ok = (c, m, e) => { (c ? PASS : FAIL).push(m); console.log((c ? '  ok   ' : '  FAIL ') + m + (e ? '   ' + e : '')); };

function get(url) {
  return new Promise((r) => {
    https.get(url, { headers: { 'user-agent': 'Mozilla/5.0 Edge/120' } }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => r({ status: res.statusCode, body: b, headers: res.headers }));
    }).on('error', e => r({ status: 0, body: '', error: e.message }));
  });
}

(async () => {
  console.log('[1] 线上代码版本');
  const js = await get(BASE + '/js/app.js' + SHARE);
  ok(js.body.indexOf('oauthRedirectTo()') > 0, '线上 app.js 已是新版本');
  const cfg = await get(BASE + '/js/config.js' + SHARE);
  ok(cfg.body.indexOf('BRPXR3GO4G') > 0, '线上 config.js 含完整分享码');

  console.log('\n[2] 回调落地页');
  const landing = await get(BASE + '/?code=bogus&provider=wechat&sharecode=BRPXR3GO4G&state=bogus');
  ok(landing.status === 200, '带分享码的回调地址返回 200（不再 403 链接不完整）', 'status=' + landing.status);

  console.log('\n[3] 授权请求参数（真实点击）');
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  let authorizeUrl = '';
  page.on('request', (req) => {
    const u = req.url();
    if (u.indexOf('/oauth/authorize') > 0) authorizeUrl = u;
  });

  await page.goto(BASE + '/' + SHARE, { waitUntil: 'load', timeout: 60000 });
  await new Promise(r => setTimeout(r, 2500));
  await page.evaluate(() => document.querySelector('.auth-tab[data-method="wechat"]').click());
  await page.click('#wechatBtn');
  await new Promise(r => setTimeout(r, 5000));

  ok(!!authorizeUrl, '拿到了授权请求');
  if (authorizeUrl) {
    const cb = new URL(authorizeUrl).searchParams.get('callback_url') || '';
    console.log('  callback_url =', cb);
    ok(/sharecode=BRPXR3GO4G/.test(cb), 'callback_url 带上了分享码（核心修复）');
    const cbu = new URL(cb);
    const keys = [...cbu.searchParams.keys()];
    ok(keys.length === 1 && keys[0] === 'sharecode', 'callback_url 只带 sharecode，没有夹带一次性参数', keys.join(','));
    ok(cb === BASE + '/?sharecode=BRPXR3GO4G', 'callback_url 与发布地址完全一致', cb);
    const finalUrl = page.url();
    ok(finalUrl.indexOf('open.weixin.qq.com') > 0, '确实跳到了微信扫码页', finalUrl.slice(0, 60) + '…');
  }

  // 截图落在项目内（相对本文件定位，项目搬到哪个盘都不散架）
  const shotDir = path.join(__dirname, '..', '.tmp');
  try { fs.mkdirSync(shotDir, { recursive: true }); } catch (e) { /* 忽略 */ }
  await page.screenshot({ path: path.join(shotDir, 'live-wechat.png') });
  await browser.close();

  console.log('\n通过 ' + PASS.length + ' 项，失败 ' + FAIL.length + ' 项');
  if (FAIL.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
