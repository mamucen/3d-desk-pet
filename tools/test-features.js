// 新增桌面功能的自动化验收
//   node tools/test-features.js
//
// 覆盖：本地桥接的“带数据指令 / 离线排队 / 回执”、待同步队列的持久化与重试、全屏判定、
//       以及快捷输入条（真实浏览器里跑 quicknote.html）的提交 / 取消行为。
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const puppeteer = require('puppeteer-core');

const { createBridge } = require('../pet-app/bridge');
const { createOutbox } = require('../pet-app/outbox');
const { isFullscreenish } = require('../pet-app/fullscreen');

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORTS = [17451, 17452];

const PASS = [], FAIL = [];
function ok(cond, msg, extra) {
  (cond ? PASS : FAIL).push(msg + (extra ? '  → ' + extra : ''));
  console.log((cond ? '  ok   ' : '  FAIL ') + msg + (extra ? '   ' + extra : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- 1. 本地桥接 ---------------- */
async function testBridge() {
  console.log('\n[1] 本地桥接（指令 / 排队 / 回执）');
  const states = [];
  const bridge = createBridge({ ports: PORTS, onState: (p) => states.push(p) });
  const port = await bridge.start();
  ok(port > 0, '桥接服务起来了', '127.0.0.1:' + port);
  if (!port) return bridge;

  const base = 'http://127.0.0.1:' + port;

  // 1.1 网页上报状态时带回执
  const res = await fetch(base + '/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appUrl: 'https://your-app-id.app.workbuddy.host/?sharecode=X',
      state: { todos: 3 },
      acked: [{ id: 'q1', ok: true }]
    })
  });
  ok(res.ok, '网页能上报状态');
  ok(states.length === 1 && Array.isArray(states[0].acked) && states[0].acked[0].id === 'q1',
    '回执能送到桌宠侧', JSON.stringify(states[0] && states[0].acked));

  // 1.2 没有长轮询挂起时，指令先入队
  const queued = bridge.push({ cmd: 'ingest', items: [{ id: 'a1', text: '离线时记的一条' }] });
  ok(queued === false, '没有挂起的轮询时不硬塞，先排队');
  const polled = await (await fetch(base + '/poll')).json();
  ok(polled.cmd === 'ingest' && polled.items && polled.items[0].id === 'a1',
    '网页一连接就能取到排队的指令', JSON.stringify(polled));

  // 1.3 在线时直接推到挂起的长轮询
  const pendingPoll = fetch(base + '/poll').then(r => r.json());
  await sleep(120);
  bridge.push({ cmd: 'ingest', items: [{ id: 'a2', text: '在线时记的一条' }] });
  const got = await pendingPoll;
  ok(got.cmd === 'ingest' && got.items[0].id === 'a2', '长轮询能实时收到入库指令', JSON.stringify(got));

  // 1.4 普通字符串指令仍然兼容（老接口）
  const p2 = fetch(base + '/poll').then(r => r.json());
  await sleep(120);
  bridge.push('ask');
  const got2 = await p2;
  ok(got2.cmd === 'ask', '「问管家」指令照旧可用', JSON.stringify(got2));

  bridge.stop();
  return null;
}

/* ---------------- 2. 待同步队列 ---------------- */
async function testOutbox() {
  console.log('\n[2] 待同步队列（落盘 / 重试 / 回执）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-outbox-'));
  const file = path.join(dir, 'outbox.json');

  const box = createOutbox(file);
  box.load();
  const a = box.add('  第一条：明天问下接口联调  ');
  ok(!!a && a.text === '第一条：明天问下接口联调', '记一条会去掉首尾空白');
  ok(box.add('   ') === null, '空白内容不会被记下');
  box.add('第二条');

  const reloaded = createOutbox(file);
  reloaded.load();
  ok(reloaded.count() === 2, '重启后（重新读文件）记录还在', reloaded.count() + ' 条');

  const due1 = reloaded.due();
  ok(due1.length === 2, '首次全部待发');
  reloaded.markSent(due1);
  ok(reloaded.due().length === 0, '刚发过的不重复投递（8 秒内）');
  ok(reloaded.due(Date.now() + 9000).length === 2, '过了间隔会重发');

  // 回执 ok 出队
  reloaded.ack([{ id: a.id, ok: true }]);
  ok(reloaded.count() === 1, '入库成功的那条出队', reloaded.count() + ' 条');

  // 失败重试 3 次后放弃
  const b = reloaded.list()[0];
  reloaded.ack([{ id: b.id, ok: false }]);
  ok(reloaded.count() === 1 && reloaded.list()[0].tries === 1, '失败会留在队列里等重试');
  reloaded.ack([{ id: b.id, ok: false }]);
  reloaded.ack([{ id: b.id, ok: false }]);
  ok(reloaded.count() === 0, '重试到上限就放弃，不会永久卡住');

  // 上限保护
  for (let i = 0; i < 130; i++) reloaded.add('批量 ' + i);
  ok(reloaded.count() <= 100, '队列有上限，不会无限膨胀', reloaded.count() + ' 条');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

/* ---------------- 3. 全屏判定 ---------------- */
function testFullscreen() {
  console.log('\n[3] 全屏判定');
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  ok(isFullscreenish({ x: 0, y: 0, width: 1920, height: 1080 }, bounds) === true,
    '应用全屏（任务栏被盖住）判为全屏');
  ok(isFullscreenish({ x: 0, y: 0, width: 1920, height: 1040 }, bounds) === false,
    '正常桌面（有任务栏）不算全屏');
  ok(isFullscreenish({ x: 0, y: 0, width: 1920, height: 1079 }, bounds) === true,
    '1px 取整误差不算误判');
  ok(isFullscreenish(null, bounds) === false, '拿不到数据时不乱猜');
}

/* ---------------- 4. 快捷输入条 ---------------- */
async function testQuickNote() {
  console.log('\n[4] 快捷输入条（真实浏览器）');
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--force-device-scale-factor=2', '--hide-scrollbars']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 460, height: 62, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));

  // 顶替 Electron 的 preload
  await page.evaluateOnNewDocument(() => {
    window.__calls = { submit: [], hide: 0, fill: null };
    window.QN = {
      onFill: (cb) => { window.__fill = cb; },
      onOk: (cb) => { window.__ok = cb; },
      onError: (cb) => { window.__err = cb; },
      submit: (t) => { window.__calls.submit.push(t); },
      hide: () => { window.__calls.hide++; }
    };
  });

  await page.goto('file:///' + path.join(ROOT, 'pet-app', 'quicknote.html').replace(/\\/g, '/'), { waitUntil: 'load' });
  await sleep(200);

  ok(await page.evaluate(() => !!document.getElementById('text')), '输入条渲染出来了');

  // 输入 + 回车
  await page.evaluate(() => window.__fill({ text: '', hint: '', count: 0 }));
  await page.type('#text', '下午三点跟老王对一下接口');
  await page.keyboard.press('Enter');
  await sleep(120);
  const sent = await page.evaluate(() => window.__calls.submit);
  ok(sent.length === 1 && sent[0] === '下午三点跟老王对一下接口', '回车把内容交出去了', JSON.stringify(sent));

  // 成功回执的视觉状态
  await page.evaluate(() => window.__ok({ queued: 1, sent: true }));
  await sleep(120);
  const okState = await page.evaluate(() => ({
    cls: document.getElementById('bar').className,
    mark: document.getElementById('mark').textContent,
    hint: document.getElementById('hint').textContent
  }));
  ok(/ok/.test(okState.cls) && okState.mark === '✓', '提交后有“已记下”反馈', okState.hint);
  await page.screenshot({ path: path.join(ROOT, '.tmp', 'quicknote-ok.png') });

  // 空内容不提交
  await page.evaluate(() => window.__fill({ text: '', hint: '', count: 0 }));
  await sleep(120);
  await page.keyboard.press('Enter');
  await sleep(100);
  const empty = await page.evaluate(() => ({
    submits: window.__calls.submit.length,
    cls: document.getElementById('bar').className,
    hint: document.getElementById('hint').textContent
  }));
  ok(empty.submits === 1 && /err/.test(empty.cls), '空内容回车会被拦下', empty.hint);

  // Esc 收起
  await page.keyboard.press('Escape');
  await sleep(80);
  ok((await page.evaluate(() => window.__calls.hide)) >= 1, 'Esc 能收起输入条');

  // 剪贴板来源提示 + 待同步计数
  await page.evaluate(() => window.__fill({ text: '从剪贴板来的内容', hint: '来自剪贴板', count: 3 }));
  await sleep(120);
  const fill2 = await page.evaluate(() => ({
    v: document.getElementById('text').value,
    hint: document.getElementById('hint').textContent
  }));
  ok(fill2.v === '从剪贴板来的内容' && /攒着 3 条/.test(fill2.hint), '预填内容与待同步条数都显示', fill2.hint);
  await page.screenshot({ path: path.join(ROOT, '.tmp', 'quicknote-clip.png') });

  ok(errs.length === 0, '输入条没有脚本报错', errs.join(' | '));
  await browser.close();
}

/* ---------------- 主流程 ---------------- */
(async () => {
  await testBridge();
  await testOutbox();
  testFullscreen();
  await testQuickNote();

  console.log('\n通过 ' + PASS.length + ' 项，失败 ' + FAIL.length + ' 项');
  if (FAIL.length) {
    FAIL.forEach((f) => console.log('  × ' + f));
    process.exit(1);
  }
})();
