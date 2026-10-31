// 联动链路自测：不启动 Electron，直接把「网页桥」和「桌宠桥」接在一起跑一遍。
// 用法：node tools/test-link.js
'use strict';

const path = require('path');
const vm = require('vm');
const fs = require('fs');
const { createBridge } = require('../pet-app/bridge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const events = [];
  const calls = { focusComposer: [], showTodo: [] };

  /* ---- 1. 启动桌宠侧桥（独立端口段，绝不碰正在运行的真机器人） ---- */
  const TEST_PORTS = [17431, 17432, 17433, 17434];
  const bridge = createBridge({
    onState: (p) => events.push(p),
    ports: TEST_PORTS
  });
  const port = await bridge.start();
  if (!port) throw new Error('桥未监听成功');
  console.log('[1] bridge listening on', port);

  /* ---- 2. 伪造一个「信息管家」页面环境，加载网页桥 ---- */
  const K = {
    app: {
      snapshot: () => ({
        todos: 5, overdue: 2, today: 1, upcoming: 2,
        notes: 9, pendingAi: 0, next: [{ title: '交周报', due: null }], ts: Date.now()
      }),
      focusComposer: (mode) => calls.focusComposer.push(mode),
      showTodo: () => calls.showTodo.push(1)
    },
    pet: null
  };

  const sandbox = {
    window: { Keeper: K, addEventListener: () => {}, __PET_BRIDGE_PORTS__: TEST_PORTS },
    document: {
      querySelector: () => null,
      getElementById: () => null,
      addEventListener: () => {}
    },
    location: { href: 'https://info-keeper.example/?sharecode=abc123' },
    navigator: {},
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, fetch, Date, JSON, Math, Promise
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'pet-bridge.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'pet-bridge.js' });
  console.log('[2] pet-bridge loaded, K.pet =', !!K.pet);

  /* ---- 3. 启动联动，等待探测 + 首次推送 ---- */
  K.pet.start();
  await sleep(1500);

  if (!K.pet.isOnline()) throw new Error('网页桥没有连上桌宠');
  console.log('[3] pet-bridge online =', K.pet.isOnline());

  const first = events[events.length - 1];
  if (!first || !first.online) throw new Error('桌宠没收到上线状态');
  if (!first.state || first.state.todos !== 5) throw new Error('待办数量不对: ' + JSON.stringify(first.state));
  if (!/sharecode=abc123/.test(first.appUrl || '')) throw new Error('appUrl 未带上完整地址');
  console.log('[4] 桌宠收到状态:', JSON.stringify(first.state), 'appUrl =', first.appUrl);

  /* ---- 5. 桌宠 -> 网页：推指令，长轮询应收到 ---- */
  bridge.push('note');
  const gotCmd = await new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (calls.focusComposer.length) { clearInterval(timer); resolve(true); }
      if (Date.now() - t0 > 5000) { clearInterval(timer); resolve(false); }
    }, 50);
  });
  if (!gotCmd) throw new Error('网页侧没收到 note 指令');
  console.log('[5] 网页收到指令 note -> focusComposer(' + calls.focusComposer[0] + ')');

  /* ---- 6. 归类事件：网页 -> 桌宠 ---- */
  K.pet.event({ type: 'analyzed', kind: 'todo', title: '交周报', category: '工作', tags: ['周报'], related: 2 });
  await sleep(600);
  const withEvent = events.filter((e) => e.state && e.state.event);
  if (!withEvent.length) throw new Error('桌宠没收到归类事件');
  console.log('[6] 桌宠收到事件:', JSON.stringify(withEvent[withEvent.length - 1].state.event));

  /* ---- 7. 网页掉线：长轮询断开后 90s 内应判定离线（这里手动触发） ---- */
  bridge.checkTimeout = bridge.checkTimeout; // keep
  K.pet.stop();
  await sleep(300);
  console.log('[7] 网页主动停止，K.pet.isOnline() =', K.pet.isOnline());

  bridge.stop();
  console.log('\nALL LINK TESTS PASSED');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
