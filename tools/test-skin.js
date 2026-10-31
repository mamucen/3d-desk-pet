// 皮肤系统验收（R22）
//   node tools/test-skin.js
//
// 用户需求：5 款盲盒皮肤全部接入；换了皮肤后「还是报一个主机」
// （小机箱跟着换主题色、CPU/内存照报），下面有名字徽章。
//
// 覆盖：
//   A. 浏览器版（localStorage 真源）——换肤 / 还原 / 持久化 / 菜单格子
//   B. 桌面版（主进程真源）——onSkin 推送生效 + 皮肤小机箱数值同步
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
async function settle(ms) { await new Promise((r) => setTimeout(r, ms || 120)); }

function installFakeHost(page) {
  return page.evaluateOnNewDocument(function () {
    var calls = { skins: [], sysCb: null, say: [] };
    window.__calls = calls;
    window.PetHost = {
      active: true,
      init: function (cb) { cb({ workArea: { x: 0, y: 0, width: 1920, height: 1040 }, x: 1600, y: 700 }); },
      onCursor: function () {}, onFollow: function () {}, onTop: function () {}, onReset: function () {},
      onLink: function () {}, onDragEnd: function () {}, onSys: function (cb) { calls.sysCb = cb; },
      requestLink: function () {}, moveTo: function () {}, setFollowing: function () {},
      setClickThrough: function () {}, setAlwaysTop: function () {},
      linkCmd: function () {}, quit: function () {}, menu: function () {}, onMenuCmd: function () {},
      hostCmd: function () {},
      onSay: function (cb) { calls.sayCb = cb; },
      onSkin: function (cb) { calls.skinCb = cb; }
    };
  });
}

async function openPage(browser, mode) {
  const page = await browser.newPage();
  await page.setViewport({ width: 164, height: 252 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (mode === 'desktop') await installFakeHost(page);
  await page.goto(PAGE, { waitUntil: 'load' });
  await settle(360);
  page.__errors = errors;
  return page;
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=300,500']
  });
  try {
    /* ---------- A. 浏览器版 ---------- */
    console.log('\n[A] 浏览器版（localStorage）');
    let page = await openPage(browser, 'browser');

    ok(page.__errors.length === 0, '页面无 JS 报错', page.__errors.join(' | '));

    let st = await page.evaluate(() => ({
      skin: window.__getSkin && window.__getSkin(),
      card: document.getElementById('pet').classList.contains('skin-card'),
      robotShown: getComputedStyle(document.querySelector('#pet .robot')).display !== 'none',
      imgShown: getComputedStyle(document.getElementById('skinImg')).display !== 'none'
    }));
    ok(st.skin === 'robot', '默认皮肤是经典机器人', st.skin);
    ok(!st.card && st.robotShown && !st.imgShown, '默认态：3D 机器人显示、卡片皮肤隐藏');

    await page.evaluate(() => window.__setSkin('stellar'));
    await settle();
    st = await page.evaluate(() => {
      const pet = document.getElementById('pet');
      const img = document.getElementById('skinImg');
      const cs = getComputedStyle(pet);
      return {
        skin: window.__getSkin(),
        card: pet.classList.contains('skin-card'),
        robotShown: getComputedStyle(pet.querySelector('.robot')).display !== 'none',
        imgShown: getComputedStyle(img).display !== 'none',
        src: img.getAttribute('src') || '',
        name: document.getElementById('skinName').textContent,
        rarity: document.getElementById('skinRarity').textContent,
        theme: cs.getPropertyValue('--skin').trim(),
        chassisShown: getComputedStyle(document.getElementById('skinChassis')).display !== 'none',
        tagShown: getComputedStyle(document.getElementById('skinTag')).display !== 'none'
      };
    });
    ok(st.skin === 'stellar', '换装星际喵生效', st.skin);
    ok(st.card && !st.robotShown, 'skin-card 态：3D 机器人隐藏');
    ok(st.imgShown && st.src.indexOf('pet-app/skins/stellar.png') >= 0, '皮肤图指向 stellar.png', st.src);
    ok(st.name === '星际喵', '名字徽章=星际喵', st.name);
    ok(st.rarity === 'SR 级稀有度', '稀有度徽章=SR 级稀有度', st.rarity);
    ok(st.theme === '#4da3ff', '主题色 --skin=星际蓝', st.theme);
    ok(st.chassisShown, '小机箱可见（还是报一个主机）');
    ok(st.tagShown, '名字徽章可见');

    // 逐个换：5 款都能换，名字/稀有度/主题色都对
    const expect = {
      pixel:   ['像素喵',     'R 级稀有度',  '#57d97a'],
      rich:    ['暴富喵',     'UR 级稀有度', '#e8b64c'],
      camera:  ['镜头喵',     'R 级稀有度',  '#f5c542'],
      pubg:    ['和平精英喵', 'R 级稀有度',  '#37c8f0']
    };
    for (const [id, [name, rarity, theme]] of Object.entries(expect)) {
      const s = await page.evaluate((i) => {
        window.__setSkin(i);
        return {
          skin: window.__getSkin(),
          name: document.getElementById('skinName').textContent,
          rarity: document.getElementById('skinRarity').textContent,
          theme: getComputedStyle(document.getElementById('pet')).getPropertyValue('--skin').trim(),
          src: (document.getElementById('skinImg').getAttribute('src') || '')
        };
      }, id);
      ok(s.skin === id && s.name === name && s.rarity === rarity && s.theme === theme
        && s.src.indexOf('/skins/' + id + '.png') >= 0,
        '换装 ' + name + '：名字/稀有度/主题色/图全对',
        JSON.stringify(s));
    }

    // 还原
    await page.evaluate(() => window.__setSkin('robot'));
    await settle();
    st = await page.evaluate(() => ({
      card: document.getElementById('pet').classList.contains('skin-card'),
      robotShown: getComputedStyle(document.querySelector('#pet .robot')).display !== 'none'
    }));
    ok(!st.card && st.robotShown, 'setSkin(robot) 还原 3D 机器人');

    // localStorage 持久化：存的是最后一次选的（robot），换成 rich 后 reload 应该还在
    await page.evaluate(() => window.__setSkin('rich'));
    await settle();
    await page.reload({ waitUntil: 'load' });
    await settle(360);
    st = await page.evaluate(() => ({
      skin: window.__getSkin(),
      name: document.getElementById('skinName').textContent,
      card: document.getElementById('pet').classList.contains('skin-card')
    }));
    ok(st.skin === 'rich' && st.card && st.name === '暴富喵',
      '刷新后 localStorage 皮肤仍在（rich）', JSON.stringify(st));

    // 页内菜单有 6 个皮肤格子，点格子能换装
    st = await page.evaluate(() => {
      const dots = Array.from(document.querySelectorAll('.ms-dot'));
      const pubg = dots.find((d) => d.getAttribute('data-skin') === 'pubg');
      if (!pubg) return { n: dots.length };
      pubg.click();
      return { n: dots.length, skin: window.__getSkin() };
    });
    await settle();
    const after = await page.evaluate(() => window.__getSkin());
    ok(st.n === 6, '页内菜单有 6 个皮肤格子', st.n);
    ok(after === 'pubg', '点格子换装和平精英喵生效', after);
    await page.close();

    /* ---------- B. 桌面版 ---------- */
    console.log('\n[B] 桌面版（主进程 onSkin 推送）');
    page = await openPage(browser, 'desktop');
    ok(page.__errors.length === 0, '页面无 JS 报错', page.__errors.join(' | '));

    st = await page.evaluate(() => ({ hasCb: !!window.__calls.skinCb, skin: window.__getSkin() }));
    ok(st.hasCb, '桌面版注册了 onSkin 回调');

    // 模拟主进程开机推送：settings.skin='stellar'
    await page.evaluate(() => window.__calls.skinCb('stellar'));
    await settle();
    st = await page.evaluate(() => ({
      skin: window.__getSkin(),
      card: document.getElementById('pet').classList.contains('skin-card'),
      name: document.getElementById('skinName').textContent
    }));
    ok(st.skin === 'stellar' && st.card && st.name === '星际喵',
      '主进程推送换肤生效（星际喵）', JSON.stringify(st));

    // 皮肤小机箱数值同步：喂一次系统负载，两台机箱应报同样的数
    await page.evaluate(() => window.__calls.sysCb({ cpu: 42, mem: 66, cores: [7, 9, 4], net: 0 }));
    await settle(1400); // 等平滑滚动到位
    st = await page.evaluate(() => ({
      cpu: document.getElementById('skCpu').textContent,
      mem: document.getElementById('skMem').textContent,
      core: document.getElementById('skCore').textContent,
      srvCpu: document.getElementById('srvCpu').textContent,
      srvMem: document.getElementById('srvMem').textContent,
      srvCore: document.getElementById('srvCore').textContent
    }));
    ok(st.cpu === st.srvCpu && st.mem === st.srvMem && st.core === st.srvCore,
      '皮肤机箱与主机箱报数一致', JSON.stringify(st));
    ok(st.cpu === '42' && st.mem === '66', '数值等于采样值', 'cpu=' + st.cpu + ' mem=' + st.mem);

    // 换回 robot：主进程推送还原
    await page.evaluate(() => window.__calls.skinCb('robot'));
    await settle();
    st = await page.evaluate(() => ({
      card: document.getElementById('pet').classList.contains('skin-card'),
      robotShown: getComputedStyle(document.querySelector('#pet .robot')).display !== 'none'
    }));
    ok(!st.card && st.robotShown, '主进程推送 robot 还原 3D 机器人');
    await page.close();
  } finally {
    await browser.close();
  }

  console.log('\n================ 皮肤系统：' + PASS.length + ' 通过 / ' + FAIL.length + ' 失败 ================');
  if (FAIL.length) { FAIL.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
