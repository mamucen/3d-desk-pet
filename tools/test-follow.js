// 跟随手感 + 眼睛 + 地址校验的自动化验收
// 用法： node tools/test-follow.js
// 说明：用真实浏览器（Edge）加载 robot-pet-3d.html，并用假的 PetHost 顶替 Electron，
//       这样能直接量到「窗口位置」随时间的变化，而不是靠肉眼看。
'use strict';

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = 'file:///' + path.join(ROOT, 'robot-pet-3d.html').replace(/\\/g, '/');

const PASS = [], FAIL = [];
function ok(cond, msg, extra) {
  (cond ? PASS : FAIL).push(msg + (extra ? '  → ' + extra : ''));
  console.log((cond ? '  ok   ' : '  FAIL ') + msg + (extra ? '   ' + extra : ''));
}

const HOST_MOCK = () => {
  window.__moves = [];
  window.__cmds = [];
  window.__followState = false;
  window.PetHost = {
    active: true,
    _h: {},
    moveTo(x, y) { window.__moves.push({ x, y, t: performance.now() }); },
    setFollowing(v) { window.__followState = v; },
    setClickThrough() {},
    setAlwaysTop() {},
    quit() {},
    linkCmd(c) { window.__cmds.push(c); },
    init(cb) {
      setTimeout(() => cb({
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        x: 1500, y: 660
      }), 0);
    },
    onCursor(cb) { this._h.cursor = cb; },
    onFollow(cb) { this._h.follow = cb; },
    onTop(cb) { this._h.top = cb; },
    onReset(cb) { this._h.reset = cb; },
    onLink(cb) { this._h.link = cb; },
    onSys(cb) { this._h.sys = cb; },
    requestLink() {},
    onDragEnd(cb) { this._h.dragEnd = cb; }
  };
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runBrowser() {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--force-device-scale-factor=1', '--hide-scrollbars']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

  await page.evaluateOnNewDocument(HOST_MOCK);
  await page.goto(PAGE, { waitUntil: 'load' });
  await sleep(300);

  // 打开跟随
  await page.evaluate(() => window.PetHost._h.follow(true));
  await sleep(150);
  ok(await page.evaluate(() => window.__followState === true), '跟随开关能打开');

  // ── 阶段 1：光标匀速斜向移动 1.2s（约 1000px/s），看是不是连续跟
  await page.evaluate(() => {
    window.__moves.length = 0;
    window.__done = false;
    const host = window.PetHost;
    let t0 = 0;
    function tick(now) {
      if (!t0) t0 = now;
      const t = (now - t0) / 1000;
      const k = Math.min(t, 1.2);
      host._h.cursor({ x: 60, y: 60, sx: 640 + k * 780, sy: 260 + k * 300 });
      if (t < 1.2) requestAnimationFrame(tick);
      else window.__done = true;
    }
    requestAnimationFrame(tick);
  });
  await page.waitForFunction('window.__done === true', { timeout: 6000 });
  await sleep(80);

  const moves = await page.evaluate(() => window.__moves.slice());
  ok(moves.length > 50, '1.2 秒内窗口跟随刷新足够频繁', moves.length + ' 次');

  // 停顿检测：跟随时不应该出现“跳一下、歇一会儿”。
  // 只看追上去之后的稳定跟随段（开头那次大跨度追赶会导致追上后短暂静止，属正常）。
  const steady = moves.filter(m => m.t > moves[0].t + 500);
  let maxGap = 0;
  for (let i = 1; i < steady.length; i++) maxGap = Math.max(maxGap, steady[i].t - steady[i - 1].t);
  ok(steady.length > 30 && maxGap < 45, '跟随时没有“走一下停一下”的空档',
    '最大间隔 ' + maxGap.toFixed(1) + 'ms，' + steady.length + ' 帧');

  // 单帧位移的抖动（连续两帧位移的差），越小越顺
  const steps = [];
  for (let i = 1; i < moves.length; i++) {
    steps.push(Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y));
  }
  const body = steps.slice(6);                       // 去掉起步加速段
  const jitter = body.slice(1).reduce((a, v, i) => a + Math.abs(v - body[i]), 0) / Math.max(1, body.length - 1);
  ok(jitter < 4.5, '单帧位移平滑（没有一跳一跳）', '平均抖动 ' + jitter.toFixed(2) + 'px');

  const pathLen = steps.reduce((a, v) => a + v, 0);
  ok(pathLen > 900, '确实一路跟过来了（按路径长度算）', pathLen.toFixed(0) + 'px');

  // ── 阶段 2：光标定住，看能不能停稳在头顶下方
  const settle = await page.evaluate(async () => {
    const host = window.PetHost;
    host._h.cursor({ x: 60, y: 60, sx: 900, sy: 500 });
    await new Promise(r => setTimeout(r, 700));
    const m = window.__moves[window.__moves.length - 1];
    return { x: m.x, y: m.y };
  });
  // 期望：可见机器人中心 = 光标 + 76px，视觉中心约为窗口 (82, 162)
  const dx = (settle.x + 82) - 900;
  const dy = (settle.y + 162) - (500 + 76);
  ok(Math.abs(dx) < 6 && Math.abs(dy) < 6, '停下时正好挂在光标下方',
    '偏差 (' + dx.toFixed(1) + ', ' + dy.toFixed(1) + ')');

  // ── 阶段 3：光标瞬移到远处，多久能追上（用户最烦的“赶不上”）
  const catchUp = await page.evaluate(async () => {
    const host = window.PetHost;
    const t0 = performance.now();
    host._h.cursor({ x: 60, y: 60, sx: 240, sy: 180 });
    let reached = -1;
    for (let i = 0; i < 70; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const m = window.__moves[window.__moves.length - 1];
      if (Math.hypot(m.x + 82 - 240, m.y + 162 - (180 + 76)) < 20) { reached = performance.now() - t0; break; }
    }
    return reached;
  });
  ok(catchUp > 0 && catchUp < 700, '光标瞬移后能快速追上', catchUp > 0 ? Math.round(catchUp) + 'ms' : '没追上');

  // ── 阶段 4：光标摸到它身上必须站定，让人点得到「停止」按钮
  const frozen = await page.evaluate(async () => {
    const host = window.PetHost;
    // 先让它停在 (900,500) 下方
    host._h.cursor({ x: 60, y: 60, sx: 900, sy: 500 });
    await new Promise(r => setTimeout(r, 700));
    // 光标慢慢移到机器人身上
    for (let k = 0; k <= 20; k++) {
      host._h.cursor({ x: 60, y: 60, sx: 900, sy: 500 + k * 6 });
      await new Promise(r => setTimeout(r, 20));
    }
    await new Promise(r => setTimeout(r, 300));
    const p1 = window.__moves[window.__moves.length - 1];
    // 在它身上继续蹭 400ms，位置必须一动不动
    for (let k = 0; k < 20; k++) {
      host._h.cursor({ x: 60, y: 60, sx: 880 + (k % 2) * 40, sy: 600 + (k % 3) * 8 });
      await new Promise(r => setTimeout(r, 20));
    }
    const p2 = window.__moves[window.__moves.length - 1];
    return { still: p1.x === p2.x && p1.y === p2.y, pos: p2 };
  });
  ok(frozen.still, '光标碰到它身上时会站定（按钮点得到）',
    frozen.still ? '' : '还在动');

  // ── 阶段 5：光标离开后恢复跟随
  const resumed = await page.evaluate(async () => {
    const host = window.PetHost;
    const before = window.__moves[window.__moves.length - 1];
    host._h.cursor({ x: 60, y: 60, sx: 500, sy: 400 });
    await new Promise(r => setTimeout(r, 500));
    const after = window.__moves[window.__moves.length - 1];
    return Math.hypot(after.x - before.x, after.y - before.y) > 100;
  });
  ok(resumed, '光标离开后继续跟随');

  // ── 阶段 6：快捷键 F 能开关跟随
  await page.keyboard.press('f');
  await sleep(120);
  const offByF = await page.evaluate(() => window.__followState === false);
  ok(offByF, '按 F 能关掉跟随');
  await page.keyboard.press('f');
  await sleep(120);
  const onByF = await page.evaluate(() => window.__followState === true);
  ok(onByF, '再按 F 能打开跟随');
  // 收尾：关掉跟随，避免影响后面截图
  await page.evaluate(() => window.PetHost._h.follow(false));
  await sleep(150);

  // ── 阶段 6.5：尺寸（普通模式要变小，跟随模式维持）
  const scaleOf = () => page.evaluate(() => {
    const t = getComputedStyle(document.querySelector('.scale')).transform;
    const m = /matrix\(([^)]+)\)/.exec(t);
    return m ? parseFloat(m[1].split(',')[0]) : 1;
  });
  await sleep(500);
  const sNormal = await scaleOf();
  ok(Math.abs(sNormal - 0.75) < 0.03, '普通（待命）模式缩小到 0.75', sNormal.toFixed(2));
  await page.evaluate(() => window.PetHost._h.follow(true));
  await sleep(600);
  const sFollow = await scaleOf();
  ok(Math.abs(sFollow - 0.58) < 0.03, '跟随模式仍是 0.58', sFollow.toFixed(2));
  await page.evaluate(() => window.PetHost._h.follow(false));
  await sleep(500);

  // ── 阶段 6.6：CPU 高的时候会“说出来”
  const hot = await page.evaluate(async () => {
    const sys = window.PetHost._h.sys;
    sys({ cpu: 91, coreMax: 96, mem: 42, cores: 16, ts: Date.now() });
    await new Promise(r => setTimeout(r, 300));
    sys({ cpu: 93, coreMax: 97, mem: 42, cores: 16, ts: Date.now() });
    for (let i = 0; i < 25 && !document.getElementById('pet').classList.contains('hot'); i++) {
      await new Promise(r => setTimeout(r, 200));
    }
    return {
      hot: document.getElementById('pet').classList.contains('hot'),
      bubble: document.getElementById('bubble').textContent
    };
  });
  ok(hot.hot, 'CPU 持续高时进入“发烫”状态');
  ok(/CPU/.test(hot.bubble) && /9\d/.test(hot.bubble), '会把 CPU 占用用气泡说出来', JSON.stringify(hot.bubble));

  const cool = await page.evaluate(async () => {
    const sys = window.PetHost._h.sys;
    sys({ cpu: 26, coreMax: 33, mem: 42, cores: 16, ts: Date.now() });
    await new Promise(r => setTimeout(r, 2200));
    sys({ cpu: 24, coreMax: 30, mem: 42, cores: 16, ts: Date.now() });
    for (let i = 0; i < 40 && document.getElementById('pet').classList.contains('hot'); i++) {
      await new Promise(r => setTimeout(r, 200));
    }
    return document.getElementById('pet').classList.contains('hot');
  });
  ok(!cool, 'CPU 降下来后自动退出“发烫”状态');

  // 单次抖动不该乱叫
  const noSpam = await page.evaluate(async () => {
    const sys = window.PetHost._h.sys;
    const before = document.getElementById('bubble').textContent;
    sys({ cpu: 99, coreMax: 100, mem: 42, cores: 16, ts: Date.now() });
    await new Promise(r => setTimeout(r, 2200));
    return { hot: document.getElementById('pet').classList.contains('hot'), changed: document.getElementById('bubble').textContent !== before };
  });
  ok(!noSpam.hot, '只抖一下（单次采样）不会误报');

  // 多核机器上单线程程序：平均值不高，但一颗核被顶满 → 也要报
  const coreHot = await page.evaluate(async () => {
    const sys = window.PetHost._h.sys;
    const isHot = () => document.getElementById('pet').classList.contains('hot');
    sys({ cpu: 31, coreMax: 97, mem: 42, cores: 16, ts: Date.now() });
    await new Promise(r => setTimeout(r, 300));
    sys({ cpu: 29, coreMax: 98, mem: 42, cores: 16, ts: Date.now() });
    for (let i = 0; i < 25 && !isHot(); i++) await new Promise(r => setTimeout(r, 200));
    const got = isHot();
    // 收尾：凉下来
    sys({ cpu: 20, coreMax: 30, mem: 42, cores: 16, ts: Date.now() });
    await new Promise(r => setTimeout(r, 2200));
    sys({ cpu: 18, coreMax: 28, mem: 42, cores: 16, ts: Date.now() });
    for (let i = 0; i < 30 && isHot(); i++) await new Promise(r => setTimeout(r, 200));
    return { got, cleared: !isHot() };
  });
  ok(coreHot.got, '单核被顶满（平均不高）也能识别为忙');
  ok(coreHot.cleared, '这种情况也能恢复');

  // ── 阶段 6.7：性能读数直接写在怀里的服务器面板上（实时曲线 + 平滑滚动数字）
  // 轻载：数字 + 曲线 + 指示灯都该是“凉”的样子
  const panelIdle = await page.evaluate(async () => {
    const sys = window.PetHost._h.sys;
    const before = document.querySelectorAll('#srvGraph i.on').length;
    sys({ cpu: 12, coreMax: 26, mem: 58, cores: 28, ts: Date.now() });
    await new Promise(r => setTimeout(r, 700));   // 等数字滚到位
    const box = document.querySelector('.srv-face');
    const r = box.getBoundingClientRect();
    const lastBar = document.querySelector('#srvGraph i:last-child');
    return {
      before,
      onBars: document.querySelectorAll('#srvGraph i.on').length,
      cpu: document.getElementById('srvCpu').textContent,
      mem: document.getElementById('srvMem').textContent,
      core: document.getElementById('srvCore').textContent,
      lastBarOn: lastBar.classList.contains('on'),
      lastBarH: parseFloat(lastBar.style.height),
      led: document.getElementById('srvLed').className,
      hot: document.getElementById('pet').classList.contains('hot'),
      overflowX: box.scrollWidth - box.clientWidth,
      overflowY: box.scrollHeight - box.clientHeight,
      w: r.width
    };
  });
  ok(panelIdle.cpu === '12' && panelIdle.mem === '58' && panelIdle.core === '26',
    'CPU 是多少就显示多少（轻载）', JSON.stringify([panelIdle.cpu, panelIdle.mem, panelIdle.core]));
  ok(panelIdle.onBars === Math.min(26, panelIdle.before + 1) && panelIdle.lastBarOn,
    '每来一帧采样曲线就滚一根', panelIdle.before + ' → ' + panelIdle.onBars + ' 根');
  ok(panelIdle.lastBarH === 12, '曲线高度就是真实占用', panelIdle.lastBarH + '%');
  ok(panelIdle.led === 'srv-led', '轻载时指示灯是凉色', panelIdle.led);
  ok(!panelIdle.hot, '轻载不进发烫状态');
  ok(panelIdle.overflowX === 0 && panelIdle.overflowY === 0, '面板内容不溢出');
  ok(panelIdle.w > 30, '面板在待命模式下肉眼可读', panelIdle.w.toFixed(1) + 'px');

  // 数字平滑滚动：采样跳变后，中途应该处于“滚动中”，最终停在真实值上
  const roll = await page.evaluate(async () => {
    const sys = window.PetHost._h.sys;
    sys({ cpu: 4, coreMax: 8, mem: 40, cores: 28, ts: Date.now() });
    await new Promise(r => setTimeout(r, 900));      // 滚到 4
    sys({ cpu: 88, coreMax: 90, mem: 60, cores: 28, ts: Date.now() });
    await new Promise(r => setTimeout(r, 120));      // 滚动中途
    const mid = document.getElementById('srvCpu').textContent;
    await new Promise(r => setTimeout(r, 900));      // 滚完
    return { mid, end: document.getElementById('srvCpu').textContent };
  });
  ok(+roll.mid > 4 && +roll.mid < 88, '数字是平滑滚动的（不是瞬间跳变）', '中途 ' + roll.mid);
  ok(roll.end === '88', '滚完停在真实采样值上', roll.end);

  // 过载：面板跟着变红、数字更新、指示灯急闪
  const panelHot = await page.evaluate(async () => {
    const sys = window.PetHost._h.sys;
    sys({ cpu: 93, coreMax: 97, mem: 74, cores: 28, ts: Date.now() });
    await new Promise(r => setTimeout(r, 300));
    sys({ cpu: 93, coreMax: 97, mem: 74, cores: 28, ts: Date.now() });
    for (let i = 0; i < 25 && !document.getElementById('pet').classList.contains('hot'); i++) {
      await new Promise(r => setTimeout(r, 200));
    }
    await new Promise(r => setTimeout(r, 700));
    return {
      cpu: document.getElementById('srvCpu').textContent,
      mem: document.getElementById('srvMem').textContent,
      core: document.getElementById('srvCore').textContent,
      crit: document.querySelectorAll('#srvGraph i.on.crit').length,
      led: document.getElementById('srvLed').className,
      ledDur: parseFloat(document.getElementById('srvLed').style.animationDuration),
      hot: document.getElementById('pet').classList.contains('hot')
    };
  });
  ok(panelHot.cpu === '93' && panelHot.core === '97' && panelHot.mem === '74',
    '过载时面板数字实时更新', JSON.stringify([panelHot.cpu, panelHot.core, panelHot.mem]));
  ok(panelHot.crit >= 1, '曲线高位段变红', panelHot.crit + ' 根红');
  ok(/crit/.test(panelHot.led), '过载时指示灯变红');
  ok(panelHot.ledDur <= 0.4, '越忙闪得越急', panelHot.ledDur + 's');
  ok(panelHot.hot, '面板和整体“发烫”状态同步');

  // 满载三位数不撑爆面板
  const panelMax = await page.evaluate(async () => {
    const sys = window.PetHost._h.sys;
    sys({ cpu: 100, coreMax: 100, mem: 100, cores: 28, ts: Date.now() });
    await new Promise(r => setTimeout(r, 800));
    const box = document.querySelector('.srv-face');
    return {
      cpu: document.getElementById('srvCpu').textContent,
      overflowX: box.scrollWidth - box.clientWidth
    };
  });
  ok(panelMax.cpu === '100' && panelMax.overflowX === 0, 'CPU 100% 三位数也不撑爆面板', panelMax.cpu);

  // ── 阶段 4：眼睛。摸着脑袋的时候两只眼睛不能叠成一条
  const eyes = await page.evaluate(() => {
    const pet = document.getElementById('pet');
    pet.classList.add('happy');
    const domes = [...document.querySelectorAll('.eye-happy')].map(e => e.getBoundingClientRect());
    const diamonds = [...document.querySelectorAll('.eye')].map(e => e.getBoundingClientRect());
    return {
      domes: domes.map(r => ({ l: r.left, r: r.right, w: r.width, h: r.height })),
      diamonds: diamonds.map(r => ({ l: r.left, r: r.right, c: (r.left + r.right) / 2 })),
      overlap: domes.length === 2 ? (domes[0].right - domes[1].left) : 999
    };
  });
  ok(eyes.domes.length === 2, '两只笑眼都在');
  ok(eyes.overlap < 0, '两只笑眼不重叠（不会糊成一条）',
    '间距 ' + (-eyes.overlap).toFixed(1) + 'px');
  const c0 = (eyes.domes[0].l + eyes.domes[0].r) / 2;
  const c1 = (eyes.domes[1].l + eyes.domes[1].r) / 2;
  const d0 = (eyes.diamonds[0].l + eyes.diamonds[0].r) / 2;
  const d1 = (eyes.diamonds[1].l + eyes.diamonds[1].r) / 2;
  // 头会转向光标，绝对位置随视角变；两眼间距才是稳定量
  ok(Math.abs((c1 - c0) - (d1 - d0)) < 6, '笑眼间距和正常眼睛一致',
    '笑眼 ' + (c1 - c0).toFixed(1) + 'px vs 正常 ' + (d1 - d0).toFixed(1) + 'px');

  const happyShot = path.join(ROOT, '.tmp', 'eyes-happy.png');
  const normalShot = path.join(ROOT, '.tmp', 'eyes-normal.png');
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  const petEl = await page.$('#pet');
  await petEl.screenshot({ path: happyShot });
  await page.evaluate(() => document.getElementById('pet').classList.remove('happy'));
  await sleep(200);
  await petEl.screenshot({ path: normalShot });

  ok(errs.length === 0, '页面无脚本报错', errs.slice(0, 2).join(' | ') || '');
  await browser.close();
  return { happyShot, normalShot };
}

/* ── 地址校验：直接跑文件里那份源码，保证测的是线上同一段逻辑 ── */
function runUrlCases() {
  const html = fs.readFileSync(path.join(ROOT, 'robot-pet-3d.html'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'pet-app', 'main.js'), 'utf8');

  const grab = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('找不到 ' + name);
    let depth = 0, j = src.indexOf('{', i);
    for (let k = j; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
    }
    throw new Error('解析失败 ' + name);
  };

  const usableUrl = new Function(grab(html, 'usableUrl') + '; return usableUrl;')();
  const pickUrl = new Function(grab(mainSrc, 'pickUrl') + '; return pickUrl;')();

  const cases = [
    ['https://x/', ''],                                             // 之前缓存下来的占位地址
    ['https://info-keeper.example/?sharecode=demo', ''],            // 测试污染事件里的假域名
    ['https://your-app-id.app.workbuddy.host/?sharecode=YOUR_SHARECODE',
      'https://your-app-id.app.workbuddy.host/?sharecode=YOUR_SHARECODE'],
    ['http://localhost:8099/', 'http://localhost:8099/'],
    ['not a url', ''],
    ['', '']
  ];
  cases.forEach(([input, expect]) => {
    const a = usableUrl(input);
    const b = pickUrl(input);
    ok(a === expect, 'usableUrl(' + JSON.stringify(input) + ')', JSON.stringify(a));
    ok(b === expect, 'pickUrl(' + JSON.stringify(input) + ')', JSON.stringify(b));
  });
}

(async () => {
  console.log('\n[1] 跟随 / 眼睛（真实浏览器）');
  const shots = await runBrowser();
  console.log('\n[2] 地址校验');
  runUrlCases();

  console.log('\n通过 ' + PASS.length + ' 项，失败 ' + FAIL.length + ' 项');
  if (FAIL.length) { FAIL.forEach(f => console.log('  × ' + f)); process.exit(1); }
  console.log('截图：' + shots.happyShot + '\n      ' + shots.normalShot);
})().catch(e => { console.error(e); process.exit(1); });
