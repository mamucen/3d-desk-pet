// 网页桥 UI 自测：真实 jsdom 环境 + 真实桌宠桥，验证连接状态点与指令回调。
// 用法：NODE_PATH=<managed node_modules> node tools/test-bridge-ui.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { createBridge } = require('../pet-app/bridge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dom = new JSDOM(
    '<body><div id="app"><aside><div class="side-foot"><button id="signOut"></button></div></aside></div></body>',
    { url: 'https://info-keeper.example/?sharecode=demo', runScripts: 'outside-only' }
  );
  const w = dom.window;

  const calls = { focus: [], todo: [] };
  const TEST_PORTS = [17441, 17442, 17443, 17444];
  w.__PET_BRIDGE_PORTS__ = TEST_PORTS;   // 独立端口段，绝不碰正在运行的真机器人
  w.Keeper = {
    app: {
      snapshot: () => ({ todos: 4, overdue: 0, today: 2, upcoming: 2, notes: 8, pendingAi: 0, next: [], ts: Date.now() }),
      focusComposer: (m) => calls.focus.push(m),
      showTodo: () => calls.todo.push(1)
    }
  };
  w.fetch = fetch;                       // 用 Node 的 fetch（jsdom 没有实现）
  w.AbortController = AbortController;
  w.console = console;

  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'pet-bridge.js'), 'utf8');
  w.eval(code);

  const el = () => w.document.getElementById('petLink');
  const text = () => (el() ? el().textContent : '(不存在)');

  /* ---- 初始：未启动时不应有状态点 ---- */
  if (el()) throw new Error('还没 start 就出现了状态点');

  /* ---- 先把桌宠桥起起来，再让网页桥去探测 ---- */
  const bridge = createBridge({ onState: () => {}, ports: TEST_PORTS });
  const port = await bridge.start();
  if (!port) throw new Error('桌宠桥启动失败');

  w.Keeper.pet.start();
  if (!el()) throw new Error('start 后没有创建状态点');
  if (text().indexOf('未运行') < 0) throw new Error('初始文案不对: ' + text());
  console.log('[1] 初始状态点:', text());

  /* ---- 等待连接成功 ---- */
  await sleep(1500);
  if (text().indexOf('已连接') < 0 || !el().classList.contains('on')) {
    throw new Error('连接后状态点没变绿: ' + text());
  }
  console.log('[2] 连接后状态点:', text(), '(port ' + port + ')');

  /* ---- 桌宠推指令 ---- */
  bridge.push('note');
  const ok = await new Promise((resolve) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      if (calls.focus.length) { clearInterval(t); resolve(true); }
      if (Date.now() - t0 > 5000) { clearInterval(t); resolve(false); }
    }, 40);
  });
  if (!ok || calls.focus[0] !== 'note') throw new Error('没收到 note 指令');
  console.log('[3] 指令回调 focusComposer(' + calls.focus[0] + ') 触发');

  /* ---- 桌宠推状态（在网页侧表现为 appUrl 上报） ---- */
  const state = w.Keeper.app.snapshot();
  if (state.todos !== 4) throw new Error('快照数字不对');
  console.log('[4] 快照正常: todos=' + state.todos);

  /* ---- 停止 ---- */
  w.Keeper.pet.stop();
  await sleep(200);
  if (text().indexOf('未运行') < 0) throw new Error('停止后状态点没恢复: ' + text());
  console.log('[5] 停止后状态点:', text());

  bridge.stop();
  console.log('\nALL BRIDGE-UI TESTS PASSED');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
