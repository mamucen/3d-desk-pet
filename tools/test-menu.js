// 右键菜单 / 负载面板 的桌面版验收
//   node tools/test-menu.js
//
// 用户报的两个问题：
//   1) 右键时页内菜单被 164x252 的小窗口裁掉，还老被小人挡住 → 桌面版必须走系统原生菜单
//   2) 「显示负载」在小机箱里显示不完整 → 必须改成开浏览器大盘
'use strict';

const path = require('path');
const puppeteer = require('puppeteer-core');

const PAGE = 'file:///' + path.resolve(__dirname, '..', 'robot-pet-3d.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const PASS = [], FAIL = [];
function ok(cond, msg, extra) {
  (cond ? PASS : FAIL).push(msg + (extra ? '  → ' + extra : ''));
  console.log((cond ? '  ok   ' : '  FAIL ') + msg + (extra ? '   ' + extra : ''));
}

/* 假的桌面宿主：把页面调到的接口全部记下来 */
function installFakeHost(page, opts) {
  const o = opts || {};
  return page.evaluateOnNewDocument(function (cfg) {
    var calls = { menu: [], hostCmd: [], linkCmd: [], quit: 0, say: [], menuCmdCb: null };
    window.__calls = calls;
    var noop = function () {};
    window.PetHost = {
      active: true,
      init: function (cb) {
        cb(cfg.withState ? {
          workArea: { x: 0, y: 0, width: 1920, height: 1040 },
          x: 1600, y: 700
        } : undefined);
      },
      onCursor: noop, onFollow: noop, onTop: noop, onReset: noop, onLink: noop,
      onDragEnd: noop, onSys: noop, requestLink: noop, moveTo: noop,
      setFollowing: noop, setClickThrough: noop, setAlwaysTop: noop,
      linkCmd: function (c) { calls.linkCmd.push(c); },
      quit: function () { calls.quit += 1; },
      onSay: function (cb) { window.__say = cb; },
      // 关键：桌面版提供的菜单能力
      menu: function (st) { calls.menu.push(st); },
      onMenuCmd: function (cb) { calls.menuCmdCb = cb; },
      hostCmd: function (n) { calls.hostCmd.push(n); }
    };
  }, { withState: !!(opts && opts.withState) });
}

async function openPage(browser, fakeHost) {
  const page = await browser.newPage();
  await page.setViewport({ width: 164, height: 252 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (fakeHost) await installFakeHost(page, fakeHost);
  await page.goto(PAGE, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 320));
  page.__errors = errors;
  return page;
}

function menuVisible(page) {
  return page.evaluate(function () {
    var m = document.getElementById('menu');
    var cs = getComputedStyle(m);
    var r = m.getBoundingClientRect();
    return { cls: m.classList.contains('show'), display: cs.display, opacity: cs.opacity, w: r.width, h: r.height };
  });
}

/* ---------------- 1. 桌面版：右键只弹系统菜单 ---------------- */
async function testDesktopMenu(browser) {
  console.log('\n[1] 桌面版右键（窗口只有 164x252）');
  const page = await openPage(browser, { withState: true });

  const box = await page.evaluate(function () {
    var r = document.getElementById('pet').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 160));

  const calls = await page.evaluate(() => window.__calls.menu);
  ok(calls.length === 1, '右键交给系统原生菜单（只弹一次）', calls.length + ' 次');
  ok(calls[0] && typeof calls[0].follow === 'boolean' && typeof calls[0].top === 'boolean' && typeof calls[0].tts === 'boolean',
    '菜单拿到当前状态（跟随/置顶/播报）', JSON.stringify(calls[0]));

  const mv = await menuVisible(page);
  ok(!mv.cls && mv.display === 'none' && mv.w === 0, '页内菜单不再画出来（不会被小窗口裁掉）',
    'show=' + mv.cls + ' display=' + mv.display + ' ' + Math.round(mv.w) + 'x' + Math.round(mv.h));

  console.log('\n[2] 菜单动作回传');
  const r2 = await page.evaluate(function () {
    var out = {};
    // 系统菜单点「系统负载面板」→ 主进程应该开浏览器
    window.__calls.menuCmdCb('sys');
    out.hostCmd = window.__calls.hostCmd.slice();
    out.bubble = (document.getElementById('bubble') || {}).textContent || '';
    window.__calls.menuCmdCb('follow');
    out.hostCmdAfter = window.__calls.hostCmd.slice();
    return out;
  });
  ok(r2.hostCmd.indexOf('status') >= 0, '「显示负载」改成开浏览器大盘', JSON.stringify(r2.hostCmd));
  ok(/大盘|浏览器/.test(r2.bubble), '顺手说了一句，不是静默', (r2.bubble || '').trim().slice(0, 24));
  ok(r2.hostCmd.indexOf('status') >= 0 && r2.hostCmd.length === r2.hostCmdAfter.length,
    '其它菜单项不会误触发负载面板', JSON.stringify(r2.hostCmdAfter));

  ok(!page.__errors.length, '页面无脚本报错', page.__errors.join(' | '));
  await page.close();
}

/* ---------------- 3. 浏览器版：页内菜单照旧 ---------------- */
async function testWebMenu(browser) {
  console.log('\n[3] 浏览器版右键（没有宿主，仍用页内菜单）');
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 640 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(PAGE, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 320));

  const box = await page.evaluate(function () {
    var r = document.getElementById('pet').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 160));

  const mv = await menuVisible(page);
  ok(mv.cls && mv.display === 'block', '浏览器里页内菜单正常弹出',
    'show=' + mv.cls + ' display=' + mv.display);
  ok(mv.w > 0 && mv.h > 0, '菜单有实际尺寸', Math.round(mv.w) + 'x' + Math.round(mv.h));

  // 浏览器版点「显示负载」→ 仍走本地 sysReport：有采样就报数，没权限就老实说
  const said = await page.evaluate(function () {
    var b = document.querySelector('#menu [data-act="sys"]');
    if (!b) return { err: '菜单里没有显示负载' };
    b.click();
    return { txt: (document.querySelector('#bubble') || {}).textContent || '' };
  });
  ok(!said.err, '浏览器版菜单里有「显示负载」');
  ok(said.txt && (/CPU/.test(said.txt) || /读不到/.test(said.txt)), '浏览器版点它有明确回应（报数或说明没权限）',
    (said.txt || '').trim().slice(0, 30));

  ok(!errors.length, '页面无脚本报错', errors.join(' | '));
  await page.close();
}

/* ---------------- 4. 气泡：长句子不能被切掉 ---------------- */
async function testBubble(browser) {
  console.log('\n[4] 气泡（长句子不许只显示一部分）');
  const long = '《【硬核】讲透 Agent 到底怎么落地》分析完了！我给它 8.2 分，PPT 报告已经放到 D 盘的「陪看报告」，Ctrl+Alt+L 直接打开。';

  // 两种摆位都试：屏幕中间气泡在头顶；贴着屏幕顶气泡改到下方
  const cases = [
    { name: '屏幕中间（气泡在上）', withState: true },
    { name: '贴着屏幕顶（气泡在下）', withState: false }
  ];

  for (const c of cases) {
    const page = await openPage(browser, { withState: c.withState });

    const first = await page.evaluate(function (t) {
      window.__say(t);
      var b = document.getElementById('bubble');
      var r = b.getBoundingClientRect();
      var cs = getComputedStyle(b);
      return {
        text: b.textContent, shown: b.classList.contains('show'),
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        sw: b.scrollWidth, cw: b.clientWidth, whiteSpace: cs.whiteSpace,
        below: b.classList.contains('below')
      };
    }, long);

    ok(first.shown && first.text, c.name + '：长句能显示', first.text);
    ok(first.text.length <= 26, c.name + '：先播一小段，不硬塞整句', first.text.length + ' 字');
    ok(first.whiteSpace !== 'nowrap', c.name + '：允许换行（原来 nowrap 必被切）', first.whiteSpace);
    ok(first.sw <= first.cw + 1, c.name + '：没有横向溢出', first.sw + ' / ' + first.cw);
    ok(first.top >= 0 && first.bottom <= 252 && first.left >= 0 && first.right <= 164,
      c.name + '：整块都在窗口内', Math.round(first.top) + '~' + Math.round(first.bottom)
        + ' / ' + Math.round(first.left) + '~' + Math.round(first.right));

    // 轮播：把出现过的文字都收上来，拼齐了（等于原句）就停
    const seen = [];
    let joined = '';
    for (let i = 0; i < 60; i++) {
      const t = await page.evaluate(() => {
        const b = document.getElementById('bubble');
        return b.classList.contains('show') ? b.textContent : '';
      });
      if (t && long.indexOf(t) >= 0 && seen[seen.length - 1] !== t) {
        seen.push(t);
        joined = seen.join('');
        if (joined === long) break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    ok(seen.length >= 2, c.name + '：长句拆成多段播放', seen.length + ' 段');
    ok(joined === long, c.name + '：所有段落连起来就是原话（一个字符都不少）',
      joined.length + ' / ' + long.length + ' 字');

    ok(!page.__errors.length, c.name + '：页面无脚本报错', page.__errors.join(' | '));
    await page.close();
  }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1']
  });
  try {
    await testDesktopMenu(browser);
    await testWebMenu(browser);
    await testBubble(browser);
  } catch (e) {
    ok(false, '测试本身抛错', e && e.message);
  } finally {
    await browser.close();
  }

  console.log('\n通过 ' + PASS.length + ' 项，失败 ' + FAIL.length + ' 项');
  if (FAIL.length) FAIL.forEach((f) => console.log('  × ' + f));
  process.exit(FAIL.length ? 1 : 0);
})();
