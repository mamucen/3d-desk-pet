// 陪看模式 + 系统负载监控页 的自动化验收
//   node tools/test-watch.js
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const { createWatcher, cleanTitle, isVideoTitle, listPendingSessions, markSessionSent, dropSession, adoptLegacySessions, noteSessionAttempt, MAX_TRIES } = require('../pet-app/watch');
const { createBridge } = require('../pet-app/bridge');

const PORTS = [17461, 17462];
const PASS = [], FAIL = [];
function ok(cond, msg, extra) {
  (cond ? PASS : FAIL).push(msg + (extra ? '  → ' + extra : ''));
  console.log((cond ? '  ok   ' : '  FAIL ') + msg + (extra ? '   ' + extra : ''));
}

/* ---- 假窗口画面：整帧是一个纯色电平，方便控制“画面动没动” ---- */
function fakeImg(level) {
  const buf = Buffer.alloc(32 * 18 * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = level; buf[i + 1] = level; buf[i + 2] = level; }
  return {
    isEmpty: () => false,
    resize: () => ({ toBitmap: () => buf, toJPEG: () => Buffer.from('jpg-' + level) }),
    toJPEG: () => Buffer.from('jpg-' + level)
  };
}
function win(id, name, level) {
  return { id, name, thumbnail: fakeImg(level) };
}

/* ---------------- 1. 标题判定 ---------------- */
function testTitle() {
  console.log('\n[1] B 站标题判定');
  ok(cleanTitle('【硬核】讲透 Agent_哔哩哔哩_bilibili') === '【硬核】讲透 Agent', '视频标题能洗掉站点后缀',
    cleanTitle('【硬核】讲透 Agent_哔哩哔哩_bilibili'));
  ok(cleanTitle('某视频 - 哔哩哔哩') === '某视频', '「- 哔哩哔哩」后缀也能洗');
  ok(isVideoTitle('【硬核】讲透 Agent_哔哩哔哩_bilibili') === true, '视频页算数');
  ok(isVideoTitle('哔哩哔哩 (゜-゜)つロ 干杯~-bilibili') === false, '首页不算（不会一开浏览器就录）');
  ok(isVideoTitle('哔哩哔哩 - 搜索') === false, '搜索页不算');
  ok(isVideoTitle('知乎 - 有问题就会有答案') === false, '别的网站不算');
}

/* ---------------- 2. 陪看会话 ---------------- */
async function testWatch() {
  console.log('\n[2] 陪看会话（自动开始 / 采帧 / 结束）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-watch-'));
  const events = [];
  let clock = 1000000;
  const levels = {};
  let windows = [];

  const watcher = createWatcher({
    capture: async () => windows,
    dir,
    now: () => clock,
    onEvent: (ev, p) => events.push({ ev, id: p && p.id, title: p && p.title, reason: p && p.reason, frames: p && p.frames })
  });

  // 第一帧：视频窗口出现 → 自动开始 + 立刻留一帧
  windows = [win('s1', '【硬核】讲透 Agent_哔哩哔哩_bilibili', 10)];
  await watcher.tick();
  ok(events.some((e) => e.ev === 'start'), '发现视频窗口自动开始');
  const s1 = watcher.status();
  ok(s1 && s1.title === '【硬核】讲透 Agent', '会话标题已清洗', s1 && s1.title);
  ok(s1 && s1.frames === 1, '起步就留了第一帧', s1 && s1.frames + ' 帧');

  // 画面没动 → 不重复存
  clock += 7000;
  await watcher.tick();
  ok(watcher.status().frames === 1, '静止画面不重复采');

  // 画面动了 + 到采样间隔 → 采一帧
  windows = [win('s1', '【硬核】讲透 Agent_哔哩哔哩_bilibili', 90)];
  clock += 7000;
  await watcher.tick();
  ok(watcher.status().frames === 2, '画面动了就采一帧', watcher.status().frames + ' 帧');

  // 帧文件真的落盘了
  const files = fs.readdirSync(dir).length;
  ok(files >= 1, '帧存在会话目录里', files + ' 个文件');

  // 采到上限：帧数减半 + 间隔翻倍（时钟步长大于两次翻倍后的间隔，保证每拍都能采）
  let saw24 = false, thinned = false, lastLevel = 0;
  for (let i = 0; i < 60; i++) {
    clock += 15000;
    lastLevel = (i * 37 + 11) % 250;
    windows = [win('s1', '【硬核】讲透 Agent_哔哩哔哩_bilibili', lastLevel)];
    await watcher.tick();
    const st = watcher.status();
    if (!st) break;
    if (st.frames >= 24) saw24 = true;
    if (saw24 && st.frames < 24) { thinned = true; break; }
  }
  ok(thinned, '攒满上限会减半瘦身');
  const capped = watcher.status();
  ok(capped && capped.frames <= 13, '瘦身后的帧数可控', capped && capped.frames + ' 帧');
  await new Promise((r) => setTimeout(r, 200));
  ok(fs.readdirSync(dir).length <= (capped ? capped.frames : 0) + 1, '瘦身时把多余帧文件也删了',
    fs.readdirSync(dir).length + ' 个文件');

  // 长时间没动（和最后一帧完全一样的画面）→ 认为看完了
  clock += 130000;
  windows = [win('s1', '【硬核】讲透 Agent_哔哩哔哩_bilibili', lastLevel)];
  await watcher.tick();
  const endEv = events.filter((e) => e.ev === 'end').pop();
  ok(!!endEv, '长时间静止自动收尾');
  ok(endEv && endEv.reason === 'silent', '结束原因：silent', endEv && endEv.reason);

  // 换视频 → 旧会话收尾 + 新会话开始
  windows = [win('s1', '第二支视频来了_哔哩哔哩_bilibili', 5)];
  await watcher.tick();
  const startEv = events.filter((e) => e.ev === 'start').pop();
  ok(startEv && startEv.title === '第二支视频来了', '切换视频自动开新会话', startEv && startEv.title);

  // 新会话至少留两帧，然后窗口关掉 → 结束（帧太少会按 discard 静默丢掉，不打扰）
  clock += 15000;
  windows = [win('s1', '第二支视频来了_哔哩哔哩_bilibili', 60)];
  await watcher.tick();
  clock += 20000;
  windows = [];
  await watcher.tick();
  const gone = events.filter((e) => e.ev === 'end').pop();
  ok(gone && gone.reason === 'gone', '窗口关闭自动收尾', gone && gone.reason);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

/* ---------------- 3. 桥接：监控页 / 分析结果回传 ---------------- */
async function testBridgeStatus() {
  console.log('\n[3] 桥接：/status 页面 + /sys 数据 + /watch-result 回传');
  const gotWatch = [];
  let sys = { cpu: 33, mem: 61, coreMax: 88, cores: 28, ts: 1, watching: false, watch: null };
  const bridge = createBridge({ ports: PORTS, onWatch: (w) => gotWatch.push(w) });
  const port = await bridge.start();
  ok(port > 0, '服务起来了', ':' + port);
  if (!port) return;
  const base = 'http://127.0.0.1:' + port;

  bridge.setStatusProvider(() => sys);

  const page = await (await fetch(base + '/status')).text();
  ok(/系统负载/.test(page) && /canvas/.test(page) && /\/sys/.test(page), '监控页 HTML 正常给出');
  ok(/watchText/.test(page) && /d\.hist&&d\.hist\.length/.test(page),
    '陪看状态按标题/帧数格式化，历史采样一开页就铺满曲线（不再 [object Object] / 空曲线）');

  const data = await (await fetch(base + '/sys')).json();
  ok(data.cpu === 33 && data.coreMax === 88 && data.cores === 28, '/sys 返回实时采样', JSON.stringify(data));

  const post = await fetch(base + '/watch-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid: 'w1', result: { verdict: '不错', rating: 8.5, points: ['a'] } })
  });
  ok(post.ok, '网页能把分析结果回传');
  await new Promise((r) => setTimeout(r, 80));
  ok(gotWatch.length === 1 && gotWatch[0].sid === 'w1' && gotWatch[0].result.rating === 8.5,
    '桌宠侧收到了陪看分析结果', JSON.stringify(gotWatch[0] && gotWatch[0].result && gotWatch[0].result.rating));

  bridge.stop();
}

/* ---------------- 5. 省资源：没到采样点不抓位图 ---------------- */
async function testLightweight() {
  console.log('\n[5] 省资源（不采样时不产生任何位图）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-light-'));
  const calls = { probe: 0, grab: 0 };
  let clock = 5000000;
  const windows = [win('s1', '【硬核】讲透 Agent_哔哩哔哩_bilibili', 20)];

  const watcher = createWatcher({
    capture: async (o) => {
      if (o && o.thumbnails) calls.grab++; else calls.probe++;
      return windows;
    },
    dir,
    now: () => clock,
    onEvent: () => {}
  });

  // 30 拍、每拍 1 秒 —— 模拟一直挂着看视频
  for (let i = 0; i < 30; i++) {
    clock += 1000;
    windows[0] = win('s1', '【硬核】讲透 Agent_哔哩哔哩_bilibili', 20 + (i % 7));
    await watcher.tick();
  }
  const total = calls.probe + calls.grab;
  ok(calls.probe === 30, '每拍都查了窗口标题（会话状态不掉）', calls.probe + ' 次轻查询');
  ok(calls.grab > 0 && calls.grab <= 6, '只有采样点才抓位图（约 6 秒一张）', calls.grab + ' 次抓图 / 30 秒');
  ok(calls.grab / total <= 0.25, '位图抓取次数压到四分之一以下（原来每拍都抓）',
    Math.round((calls.grab / total) * 100) + '%');

  // 切走 B 站窗口：只做轻查询，一张位图都不抓
  const before = { ...calls };
  for (let i = 0; i < 10; i++) {
    clock += 1000;
    windows[0] = win('s1', '记事本 - 无关窗口', 20);
    await watcher.tick();
  }
  ok(calls.grab === before.grab, '窗口不在时不抓图', calls.grab + ' 次（之前 ' + before.grab + ' 次）');

  watcher.stop('manual');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

/* ---------------- 6. 磁盘不长胖 ---------------- */
async function testPrune() {
  console.log('\n[6] 磁盘清理（只留最近几场）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-prune-'));
  // 伪造 12 场历史会话目录
  for (let i = 0; i < 12; i++) {
    fs.mkdirSync(path.join(dir, 'w' + (1000 + i).toString(36)), { recursive: true });
  }
  const before = fs.readdirSync(dir).length;
  ok(before === 12, '先铺 12 场历史素材', before + ' 个目录');

  let clock = 9000000;
  const windows = [win('s1', '今天这支视频有点长_哔哩哔哩_bilibili', 30)];
  const watcher = createWatcher({ capture: async () => windows, dir, now: () => clock, onEvent: () => {} });
  await watcher.tick();

  const after = fs.readdirSync(dir).length;
  ok(after <= 9, '开新会话时把最老的清掉', before + ' → ' + after + ' 个目录');

  watcher.stop('manual');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

/* ---------------- 7. 会话落盘 & 补发（管家没开 / 程序被关都不丢） ---------------- */
async function testPendingQueue() {
  console.log('\n[7] 看完但没分析成的会话（落盘 + 补发）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-queue-'));
  let clock = 7000000;
  const windows = [win('s1', '这场当时管家没开着_哔哩哔哩_bilibili', 40)];
  const watcher = createWatcher({ capture: async () => windows, dir, now: () => clock, onEvent: () => {} });

  // 采两帧再用“窗口关掉”收尾
  await watcher.tick();
  clock += 15000;
  windows[0] = win('s1', '这场当时管家没开着_哔哩哔哩_bilibili', 120);
  await watcher.tick();
  clock += 20000;
  windows.length = 0;
  await watcher.tick();

  const dirs = fs.readdirSync(dir).filter((n) => /^w[0-9a-z]+$/.test(n));
  ok(dirs.length === 1, '会话目录还在', dirs.length + ' 个');
  const metaFile = path.join(dir, dirs[0], 'session.json');
  ok(fs.existsSync(metaFile), '收尾时把会话写进了 session.json（以前只在内存里）');

  const pending = listPendingSessions(dir);
  ok(pending.length === 1, '能列出待分析的会话', pending.length + ' 场');
  ok(pending[0] && pending[0].title === '这场当时管家没开着', '标题、帧都在', pending[0] && pending[0].title);
  ok(pending[0] && pending[0].frames.length === 2 && fs.existsSync(pending[0].frames[0].file),
    '帧文件路径可读（补发时能现压 base64）', pending[0] && pending[0].frames.length + ' 帧');

  markSessionSent(dir, dirs[0]);
  ok(listPendingSessions(dir).length === 0, '发出去之后不再重复列出来');

  dropSession(dir, dirs[0]);
  ok(!fs.existsSync(path.join(dir, dirs[0])), '报告生成后整场素材自动清掉');

  // 老版本只落了 jpg、没有 session.json —— 也要能被认领回来补分析
  const legacy = path.join(dir, 'wlegacy01');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'f001.jpg'), 'x');
  fs.writeFileSync(path.join(legacy, 'f002.jpg'), 'x');
  ok(listPendingSessions(dir).length === 0, '旧录像一开始不在待分析队列里');
  const adopted = adoptLegacySessions(dir, 3);
  ok(adopted === 1 && listPendingSessions(dir).length === 1,
    '旧录像能被认领进队列（之前几场就是这么丢的）', adopted + ' 场');
  ok(adoptLegacySessions(dir, 3) === 0, '同一场不会被重复认领');

  // 「发出去没回音」的会话不能被判死：以前发完就改名 sent，网页没开就永久丢了
  const t1 = noteSessionAttempt(dir, 'wlegacy01');
  ok(t1 === 1 && listPendingSessions(dir).length === 1,
    '没回音只记一次重试，会话还留在队列里（这才是两轮视频没报告的真凶）', 'attempts=' + t1);
  noteSessionAttempt(dir, 'wlegacy01');
  const t3 = noteSessionAttempt(dir, 'wlegacy01');
  ok(t3 === MAX_TRIES, '重试次数会累计（可以据此放弃）', 'attempts=' + t3);
  ok(noteSessionAttempt(dir, '不存在的会话') === MAX_TRIES, '会话丢了就别无限重试');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

/* ---------------- 4. main.js 启动链路（陪看相关挂载） ---------------- */
async function smokeMain() {
  console.log('\n[4] main.js 启动链路冒烟');
  const { run } = require('./smoke-main');
  const r = await run();
  ok(r.ok && /CommandOrControl\+Alt\+B/.test(r.calls.shortcuts.join(',')), '陪看快捷键已注册',
    r.ok ? r.calls.shortcuts.join(',') : r.error);
  const need = ['ipc:qn:submit', 'ipc:qn:hide', 'ipc:pet:host-cmd', 'ipc:pet:menu'];
  const missing = need.filter((n) => r.calls.ipc.indexOf(n) < 0);
  ok(!missing.length, '快捷输入 / 菜单 / 陪看相关 IPC 全部挂上',
    missing.length ? '缺少 ' + missing.join(',') : r.calls.ipc.length + ' 个');

  // 用户报的「打开陪看报告是灰的、点不了」
  const item = r.calls.reportItem;
  ok(!!item, '右键菜单里有「打开陪看报告」', r.calls.menuError || '');
  ok(item && item.enabled, '报告项永远可点（哪怕还没生成过）', item && item.label);
  ok(item && /文件夹|份/.test(item.label), '文案按有没有报告变化', item && item.label);
  ok(r.calls.opened.some((p) => /陪看报告$/.test(String(p))),
    '点了会去打开「陪看报告」文件夹', JSON.stringify(r.calls.opened));
  ok(r.calls.opened.some((p) => /PETFakeDrive[\\/]+陪看报告$/.test(String(p))),
    '报告落在指定的盘（不再写桌面）', JSON.stringify(r.calls.opened));

  // 新加的「打开最新报告」：菜单里直接写清是哪一份，点了真的打开文件
  const latest = r.calls.latestItem;
  ok(!!latest, '右键菜单里有「打开最新报告」', r.calls.menuError || '');
  ok(latest && latest.enabled, '有报告时可以点', latest && latest.label);
  ok(latest && /测试视频/.test(latest.label), '菜单标题里看得出是哪一份', latest && latest.label);
  ok(r.calls.opened.some((p) => /\.pptx$/.test(String(p))),
    '点了会直接打开那份 PPT（不用先进文件夹）', JSON.stringify(r.calls.opened));
  ok(/CommandOrControl\+Alt\+L/.test(r.calls.shortcuts.join(',')), '最新报告有快捷键（Ctrl+Alt+L）',
    r.calls.shortcuts.join(','));

  // 「清理报告」：不必再去文件夹手动删（用户嫌占空间）
  const clean = r.calls.cleanItem;
  ok(!!clean, '右键菜单里有「清理陪看报告」', clean && clean.label);
  ok(clean && clean.enabled && /4 份/.test(clean.label), '菜单上直接写着几份、多大', clean && clean.label);
  ok(clean && /\d+(\.\d+)?\s?(KB|MB|B)/.test(clean.label), '菜单上带着占用体积', clean && clean.label);
  ok(r.calls.dialogs.length >= 1 && /4 份/.test(r.calls.dialogs[0].message),
    '点它会先弹确认框，说清楚有几份', r.calls.dialogs[0] && r.calls.dialogs[0].message);
  ok(r.calls.dialogs[0] && r.calls.dialogs[0].buttons.length === 3,
    '三个选择：留 3 份 / 全清 / 取消', r.calls.dialogs[0] && r.calls.dialogs[0].buttons.join(' / '));
  ok(r.calls.trashed.length === 1, '选「只留最近 3 份」就把最旧的 1 份丢回收站', JSON.stringify(r.calls.trashed));
  ok(r.calls.trashed.every((p) => /旧报告C/.test(String(p))),
    '删的确实是最旧的那份，不是最新报告', JSON.stringify(r.calls.trashed));

  // 一键重启
  const rs = r.calls.restartItem;
  ok(!!rs && rs.enabled, '右键菜单里有「重启小机器人」', rs && rs.label);
  ok(r.calls.relaunch.length === 1, '点重启会拉一个新进程（不是只退出）', JSON.stringify(r.calls.relaunch));
  const arg = (r.calls.relaunch[0] || {}).args;
  ok(Array.isArray(arg) && /pet-app$/.test(String(arg[0])), '开发态重启会带上工程目录', JSON.stringify(arg));
  ok(Array.isArray(arg) && arg.indexOf('--relaunch') >= 0, '重启会打上标记（新进程靠它判断该不该等锁）',
    JSON.stringify(arg));
  ok(/CommandOrControl\+Alt\+R/.test(r.calls.shortcuts.join(',')), '重启快捷键已注册',
    r.calls.shortcuts.join(','));
  ok(r.calls.lockCalls === 3 && r.calls.ipc.length > 0,
    '单实例锁被占着会重试（重启不会把桌宠弄丢）', '抢了 ' + r.calls.lockCalls + ' 次，最终起来了');

  // 一键清空缓存（给小机器人降火）
  const cache = r.calls.cacheItem;
  ok(!!cache, '右键菜单里有「一键清空缓存」', cache && cache.label);
  ok(cache && /可清|干净/.test(cache.label), '菜单上直接写着能清多少', cache && cache.label);
  const topItem = r.calls.topItem;
  ok(!!topItem && topItem.enabled, '右键菜单里有「看看谁在吃 CPU / 内存」', topItem && topItem.label);
  const cacheDlg = (r.calls.dialogs || []).find((d) => /可以安全清掉/.test(d.message || ''));
  ok(!!cacheDlg, '点它会先弹确认框，列出清什么、多大', cacheDlg && cacheDlg.message);
  ok(cacheDlg && cacheDlg.buttons.join('/') === '开始清理/取消',
    '两个选择：开始清理 / 取消', cacheDlg && cacheDlg.buttons.join(' / '));
  const cr = r.calls.cacheResult || {};
  ok(cr.sentGone === true, '已分析过的过期录像被清掉（腾空间）', JSON.stringify(cr));
  ok(cr.pendKept === true, '还在等分析的录像原样留着（不能白看）', JSON.stringify(cr));
  ok(cr.oldGone === true, '30 天前的临时文件被清掉', JSON.stringify(cr));
  ok(cr.freshKept === true, '新的临时文件不动（可能正被占用）', JSON.stringify(cr));
}

/* ---------------- 8. 录到一半被关机/断电 ---------------- */
async function testCrashSafety() {
  console.log('\n[8] 录到一半被关机：标题不能丢、重启后要能补分析');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-crash-'));
  let clock = 8000000;
  const windows = [win('c1', '看到一半关机了_哔哩哔哩_bilibili', 40)];
  const watcher = createWatcher({ capture: async () => windows, dir, now: () => clock, onEvent: () => {} });

  await watcher.tick();                                  // 第一帧
  const dirs = fs.readdirSync(dir).filter((n) => /^w[0-9a-z]+$/.test(n));
  ok(dirs.length === 1, '开录就建了会话目录');
  const metaFile = path.join(dir, dirs[0], 'session.json');
  ok(fs.existsSync(metaFile), '录第一帧就把 session.json 落盘（以前只在收尾时写）');
  let meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  ok(meta.title === '看到一半关机了', '标题已经落盘', meta.title);
  ok(meta.recording === true, '标记为「还在录」', String(meta.recording));
  ok(listPendingSessions(dir).length === 0, '正在录的场次不会被当成「看完了」提前发出去');

  clock += 12000;
  windows[0] = win('c1', '看到一半关机了_哔哩哔哩_bilibili', 150);
  await watcher.tick();                                  // 第二帧
  meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  ok(meta.frames.length === 2, '帧表逐帧更新', meta.frames.length + ' 帧');

  // 这里模拟「啪一下关机」：不调 stop、不写字，进程直接没了。重启后：
  const orphans = listPendingSessions(dir, { includeOrphans: true });
  ok(orphans.length === 1, '重启后能认领这场孤儿录像', orphans.length + ' 场');
  ok(orphans[0] && orphans[0].title === '看到一半关机了', '标题没丢（这就是逐帧落盘的意义）',
    orphans[0] && orphans[0].title);
  ok(orphans[0] && orphans[0].reason === 'orphan', '原因标成 orphan', orphans[0] && orphans[0].reason);
  meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  ok(meta.recording === false && meta.endedAt > 0, '磁盘上的「还在录」标记也收尾了',
    JSON.stringify({ recording: meta.recording, endedAt: meta.endedAt }));
  ok(listPendingSessions(dir).length === 1, '收尾后正常进入待分析队列');

  watcher.stop('manual');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

(async () => {
  testTitle();
  await testWatch();
  await testLightweight();
  await testPrune();
  await testPendingQueue();
  await testCrashSafety();
  await testBridgeStatus();
  try {
    await smokeMain();
  } catch (e) {
    ok(false, 'main.js 冒烟本身没跑起来', e && e.message);
  }

  console.log('\n通过 ' + PASS.length + ' 项，失败 ' + FAIL.length + ' 项');
  if (FAIL.length) {
    FAIL.forEach((f) => console.log('  × ' + f));
  }
  // main.js 被载进本进程后可能还留着句柄，显式退出，避免 stdout 被截断
  process.exit(FAIL.length ? 1 : 0);
})();
