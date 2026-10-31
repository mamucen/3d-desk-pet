// 待同步队列（outbox）：桌面随手记的内容先落盘，等「信息管家」网页在线时灌进去。
//
// 三条规则：
//   1. 记下的东西立刻写文件 —— 管家没开、断网、关机都不能丢；
//   2. 同一批内容 8 秒内不重复投递（防刷屏），重复投递靠 id 去重；
//   3. 网页回执 ok 才删；失败的重试 3 次后放弃，避免永久卡住。
'use strict';

const fs = require('fs');

const MAX = 100;
const RESEND_GAP_MS = 8000;
const MAX_TRIES = 3;

function makeId() {
  return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createOutbox(file, options) {
  const opts = options || {};
  const max = opts.max || MAX;
  const gap = typeof opts.resendGap === 'number' ? opts.resendGap : RESEND_GAP_MS;
  let items = [];

  function load() {
    try {
      if (file && fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(raw)) {
          items = raw.filter((x) => x && x.id && typeof x.text === 'string');
        }
      }
    } catch (err) { items = []; }
    return items;
  }

  function save() {
    try {
      if (file) fs.writeFileSync(file, JSON.stringify(items.slice(-max)));
    } catch (err) { /* 写不进去也不能影响主流程 */ }
  }

  function add(text, now) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    const item = { id: makeId(), text: t.slice(0, 4000), at: now || Date.now(), tries: 0, sentAt: 0 };
    items.push(item);
    while (items.length > max) items.shift();
    save();
    return item;
  }

  /** 该发出去的（没发过，或上次发出去超过 gap 毫秒） */
  function due(now) {
    const t = now || Date.now();
    return items.filter((x) => !x.sentAt || t - x.sentAt > gap);
  }

  /** 标记这批已经投递过（tries 只记“入库失败”的次数，不在这里加） */
  function markSent(list, now) {
    const t = now || Date.now();
    const set = new Set((list || []).map((x) => String(x.id)));
    items.forEach((x) => { if (set.has(String(x.id))) x.sentAt = t; });
    save();
  }

  /** 网页回执：ok 的删掉，失败的记一次重试，超过上限就放弃 */
  function ack(list) {
    if (!Array.isArray(list) || !list.length) return 0;
    let removed = 0;
    const next = [];
    for (const x of items) {
      const hit = list.find((a) => String((a && a.id) || a) === String(x.id));
      if (!hit) { next.push(x); continue; }
      const ok = !(hit && typeof hit === 'object' && hit.ok === false);
      if (ok) { removed++; continue; }                 // 入库成功，出队
      x.tries = (x.tries || 0) + 1;
      x.sentAt = 0;                                     // 下次立刻重试
      if (x.tries < MAX_TRIES) next.push(x);
      else removed++;                                   // 重试到上限，放弃并出队
    }
    if (next.length !== items.length || removed) { items = next; save(); }
    return removed;
  }

  return {
    load, save, add, due, markSent, ack,
    list: () => items,
    count: () => items.length,
    /** 仅测试用 */
    _reset() { items = []; save(); }
  };
}

module.exports = { createOutbox, MAX, RESEND_GAP_MS, MAX_TRIES };
