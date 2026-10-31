// 主进程系统采样自测：直接跑 pet-app/main.js 里的真实采样函数
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const src = fs.readFileSync(path.join(__dirname, '..', 'pet-app', 'main.js'), 'utf8');

function grabFn(s, name) {
  const at = s.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('找不到 ' + name);
  let depth = 0;
  for (let i = s.indexOf('{', at); i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return s.slice(at, i + 1); }
  }
  throw new Error('解析失败 ' + name);
}

const code = grabFn(src, 'readCpuTimes') + '\n' + grabFn(src, 'sampleSys')
  + '\nreturn { readCpuTimes, sampleSys, setPrev: (v) => { sysPrev = v; }, getPrev: () => sysPrev };';
const api = new Function('os', 'sysPrev', code)(os, null);

const PASS = [], FAIL = [];
const ok = (c, m, e) => { (c ? PASS : FAIL).push(m); console.log((c ? '  ok   ' : '  FAIL ') + m + (e ? '   ' + e : '')); };

// 第一次采样只做基准
ok(api.sampleSys() === null, '首次采样只建立基准，不误报');

// 空闲 1.2 秒（这台机器本身可能就有负载，只校验数值合法）
const t0 = Date.now();
while (Date.now() - t0 < 1200) { /* 空转 */ }
const idle = api.sampleSys();
ok(idle && typeof idle.cpu === 'number' && idle.cpu >= 0 && idle.cpu <= 100, 'CPU 数值合法', idle && idle.cpu + '%');
ok(idle && typeof idle.mem === 'number' && idle.mem > 0 && idle.mem <= 100, '内存占用在合理区间', idle && idle.mem + '%');
ok(idle && idle.cores === (os.cpus() || []).length, '核数正确', idle && idle.cores);
ok(idle && idle.coreMax >= 0 && idle.coreMax <= 100, '最忙单核数值合法', idle && idle.coreMax + '%');

// 单线程压测 1.5 秒：多核机器上平均值变化很小，但“最忙单核”必须看得出来
const busyUntil = Date.now() + 1500;
while (Date.now() < busyUntil) { Math.sqrt(Math.random()); }
const busy = api.sampleSys();
ok(busy && busy.coreMax >= 55, '单线程压满一颗核能被 coreMax 抓到', busy && busy.coreMax + '%');
ok(busy && busy.coreMax > busy.cpu, '单核读数高于平均值（多核机器的关键判据）', busy && busy.coreMax + '% vs ' + busy.cpu + '%');

console.log('\n通过 ' + PASS.length + ' 项，失败 ' + FAIL.length + ' 项');
if (FAIL.length) process.exit(1);
