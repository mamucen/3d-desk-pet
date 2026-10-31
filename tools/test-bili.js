// B 站数据接入的自动化验收（全程 mock 网络，不依赖外网，跑得稳定）
//   node tools/test-bili.js
'use strict';

const zlib = require('zlib');
const bili = require('../pet-app/bili');
const watch = require('../pet-app/watch');

const PASS = [], FAIL = [];
function ok(cond, msg, extra) {
  (cond ? PASS : FAIL).push(msg + (extra ? '  → ' + extra : ''));
  console.log((cond ? '  ok   ' : '  FAIL ') + msg + (extra ? '   ' + extra : ''));
}

/* ---------------- 假网络 ---------------- */
let routes = {};
let httpCalls = [];                        // 记录每次请求的 url + headers，用来验 Cookie
function mockFetch(map) { routes = map; }

function jsonBody(obj) {
  return { text: async () => JSON.stringify(obj) };
}

global.fetch = async function (url, opts) {
  const u = String(url);
  httpCalls.push({ url: u, headers: (opts && opts.headers) || {} });
  for (const key of Object.keys(routes)) {
    if (u.indexOf(key) >= 0) {
      const r = routes[key];
      if (r && r.arrayBuffer) return r;
      if (typeof r === 'function') return r(u);
      return jsonBody(r);
    }
  }
  throw new Error('未 mock 的请求: ' + u);
};

function callsTo(sub) { return httpCalls.filter((c) => c.url.indexOf(sub) >= 0); }

/* ---------------- 1. 标题匹配 ---------------- */
function testMatch() {
  console.log('\n[1] 标题清洗与相似度');
  // 注意分工：watch.cleanTitle 负责去掉「_哔哩哔哩_bilibili」这类站点后缀，
  // bili.normalizeTitle 只负责去掉标点/空格/大小写，两者串起来才是喂给搜索的 kw。
  ok(bili.normalizeTitle('【硬核】讲透 Agent！') === '硬核讲透agent',
    '去掉标点/括号/空格', bili.normalizeTitle('【硬核】讲透 Agent！'));
  const realTitle = '【硬核】讲透 Agent！_哔哩哔哩_bilibili';
  const kw = bili.normalizeTitle(watch.cleanTitle(realTitle));
  ok(kw === '硬核讲透agent', '真实窗口标题 → 干净关键词', kw);
  ok(bili.commonLen('丐中丐版的8代高尔夫', '丐中丐版的8代高尔夫值得买吗') === 10,
    '最长公共子串算得对', String(bili.commonLen('丐中丐版的8代高尔夫', '丐中丐版的8代高尔夫值得买吗')));
  ok(bili.commonLen('完全不同', '毫无关系') === 0, '毫不相干返回 0');
}

/* ---------------- 2. 标题 → BV ---------------- */
const SPI = { code: 0, data: { b_3: 'buvid3-test-abc', b_4: 'buvid4-test-xyz' } };
const NAV = { code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png' } } };

async function testResolve() {
  console.log('\n[2] 标题反查 BV 号');
  const search = {
    code: 0,
    data: {
      result: [
        { bvid: 'BVwrong001', title: '完全无关的另一个视频' },
        { bvid: 'BVright001', title: '<em class="keyword">朋克版ITX电脑</em>DIY教程' },
        { bvid: 'BVhalf002', title: '朋克版 ITX 装机记录' }
      ]
    }
  };
  mockFetch({ '/x/frontend/finger/spi': SPI, '/x/web-interface/nav': NAV, '/wbi/search/type': search });
  httpCalls = [];
  const bv = await bili.resolveBvid('《朋克版ITX电脑》DIY教程');
  ok(bv === 'BVright001', '挑出最像的那一条（不是第一条）', bv);
  ok(callsTo('finger/spi').length >= 1, '先领匿名设备 Cookie（buvid3）', String(callsTo('finger/spi').length));
  const sCalls = callsTo('/wbi/search/type');
  ok(sCalls.length === 1 && /buvid3=buvid3-test-abc/.test(sCalls[0].headers.Cookie || ''),
    '搜索请求带上 buvid3（避免匿名 412 风控）', sCalls[0] && (sCalls[0].headers.Cookie || '(无 Cookie)'));

  mockFetch({
    '/x/frontend/finger/spi': SPI,
    '/x/web-interface/nav': NAV,
    '/wbi/search/type': { code: 0, data: { result: [{ bvid: 'BVzzz', title: '风马牛不相及的标题' }] } }
  });
  ok(await bili.resolveBvid('《朋克版ITX电脑》DIY教程') === '', '相似度不够就宁可不认（别拿错视频）');
  ok(await bili.resolveBvid('短') === '', '标题太短直接放弃（省一次请求）');
}

/* ---------------- 2.5 412 风控：换 buvid 重试 ---------------- */
async function testRiskRetry() {
  console.log('\n[2.5] 匿名被 412 风控时自动换 buvid 重试');
  let searchHits = 0;
  let spiHits = 0;
  mockFetch({
    '/x/frontend/finger/spi': () => { spiHits += 1; return jsonBody({ code: 0, data: { b_3: 'buvid3-retry-' + spiHits, b_4: '' } }); },
    '/x/web-interface/nav': NAV,
    '/wbi/search/type': () => {
      searchHits += 1;
      return jsonBody(searchHits === 1
        ? { code: -412, message: '请求被拦截' }
        : { code: 0, data: { result: [{ bvid: 'BVok412', title: '<em class="keyword">朋克版ITX电脑</em>DIY教程' }] } });
    }
  });
  await bili.anonCookie(true);                       // 先把缓存里的旧 buvid 冲掉
  httpCalls = [];
  const bv = await bili.resolveBvid('《朋克版ITX电脑》DIY教程');
  ok(bv === 'BVok412', '第一次 412，换新 buvid 后搜索成功', bv);
  ok(searchHits === 2, '搜索重试了一次', String(searchHits));
  const retries = callsTo('/wbi/search/type');
  ok(retries.length === 2 && /buvid3=buvid3-retry-2/.test(retries[1].headers.Cookie || ''),
    '重试时带上了新领的 buvid3', retries[1] && (retries[1].headers.Cookie || '(无)'));
  ok(spiHits >= 2, '重新去 finger/spi 领了设备 Cookie', String(spiHits));
}

/* ---------------- 3. 详情 / 弹幕 ---------------- */
function dmXml(rows) {
  const items = rows.map((r) => '<d p="' + r.at + ',1,25,16777215,0,0,0,0">' + r.text + '</d>').join('');
  return '<i><chatserver>chat.bilibili.com</chatserver>' + items + '</i>';
}

async function testDetail() {
  console.log('\n[3] 视频详情 + 弹幕');
  const xml = dmXml([
    { at: 10, text: '开头就来' }, { at: 20, text: '这个细节好评' }, { at: 30, text: '哈哈哈' },
    { at: 250, text: '高能预警' }, { at: 255, text: '这段绝了' }, { at: 258, text: '反复看了三遍' },
    { at: 259, text: '真的强' }, { at: 300, text: '结尾有点仓促' }
  ]);
  const deflated = zlib.deflateSync(Buffer.from(xml, 'utf8'));
  mockFetch({
    '/wbi/view': {
      code: 0,
      data: {
        bvid: 'BVright001', aid: 123, cid: 456, title: '朋克版ITX电脑 DIY教程',
        owner: { name: '装机老张' }, duration: 303, pubdate: 1700000000,
        desc: '用废料攒了一台 ITX，全程 DIY。', tname: '数码',
        stat: { view: 7353, danmaku: 8, like: 82, reply: 12 },
        pages: [{ cid: 456, duration: 303 }]
      }
    },
    '/x/v1/dm/list.so': {
      arrayBuffer: async () => deflated.buffer.slice(deflated.byteOffset, deflated.byteOffset + deflated.length)
    },
    '/x/player/wbi/v2': { code: 0, data: { subtitle: { subtitles: [] } } }
  });

  const info = await bili.videoInfo('BVright001');
  ok(info && info.title === '朋克版ITX电脑 DIY教程', '拿到标题', info && info.title);
  ok(info && info.owner === '装机老张' && info.duration === 303, '拿到 UP 主和时长');
  ok(info && info.cid === 456, '拿到第一 P 的 cid（弹幕要用）', info && String(info.cid));

  const dm = await bili.danmaku(456, 5);
  ok(dm && dm.total === 8, '弹幕解压并解析成功', dm && dm.total + ' 条');
  ok(dm && dm.samples.length === 5, '按上限抽样（不会把几千条都塞给模型）', dm && dm.samples.length + ' 条');
  ok(dm && dm.peaks.length && dm.peaks[0].count === 4, '算出最热闹的一段', dm && JSON.stringify(dm.peaks[0]));
  ok(dm && dm.samples.indexOf('高能预警') >= 0 || dm.samples.some((s) => /高能/.test(s)), '抽样里带上高能内容',
    dm && dm.samples.join('/'));

  const txt = bili.toPromptText({ ok: true, info, danmaku: dm });
  ok(/朋克版ITX电脑/.test(txt) && /装机老张/.test(txt) && /弹幕共 8 条/.test(txt),
    '拼给模型的文本包含标题/UP主/弹幕', txt.split('\n').length + ' 行');
  ok(txt.length < 3000, '文本长度可控', txt.length + ' 字');
}

/* ---------------- 4. 整体 enrich 的健壮性 ---------------- */
async function testEnrich() {
  console.log('\n[4] 整体接入（任何一步挂了都不能拖垮陪看）');
  const okNav = { code: 0, data: { wbi_img: { img_url: 'https://x/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', sub_url: 'https://x/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png' } } };
  const okSearch = {
    code: 0,
    data: {
      result: [{
        bvid: 'BVright001', aid: 9, title: '<em class="keyword">朋克版ITX电脑</em>DIY教程', author: '装机老张',
        play: 7353, danmaku: 812, duration: '5:03', typename: '数码', description: '用废料攒了一台 ITX'
      }]
    }
  };
  const okView = { code: 0, data: { bvid: 'BVright001', aid: 1, cid: 2, title: '朋克版ITX电脑DIY教程', owner: { name: '老张' }, duration: 300, desc: '', tname: '数码', stat: { view: 1, danmaku: 0, like: 0, reply: 0 }, pages: [{ cid: 2 }] } };

  // 搜索搜不到
  mockFetch({ '/x/web-interface/nav': okNav, '/wbi/search/type': { code: 0, data: { result: [] } } });
  let r = await bili.enrich('某个没人搜得到的视频标题');
  ok(r && r.ok === false && r.info === null, '搜不到就老实返回 ok:false');

  // 详情接口 500：用搜索项兜底（B 站最近常对这接口吐 HTML）
  mockFetch({
    '/x/web-interface/nav': okNav,
    '/wbi/search/type': okSearch,
    '/wbi/view': { code: -500, message: 'boom' }
  });
  r = await bili.enrich('朋克版ITX电脑DIY教程');
  ok(r && r.ok === true && r.info && r.info.partial === true, '详情挂了用搜索项兜底（标题/UP主/播放还在）',
    r && r.info && r.info.title);
  ok(r && r.info && r.info.owner === '装机老张' && r.info.stat.view === 7353, '兜底版本的 UP 主和播放数对',
    r && r.info && r.info.owner + ' / ' + (r.info.stat && r.info.stat.view));
  ok(r && r.danmaku === null, '兜底版本没有 cid，就不去硬拉弹幕');
  ok(bili.toSeconds('5:03') === 303 && bili.toSeconds('1:02:33') === 3753, '时长字符串能转成秒',
    bili.toSeconds('1:02:33'));

  // 弹幕挂了，其它照常
  mockFetch({
    '/x/web-interface/nav': okNav,
    '/wbi/search/type': okSearch,
    '/wbi/view': okView,
    '/x/v1/dm/list.so': { arrayBuffer: async () => { throw new Error('danmaku down'); } }
  });
  r = await bili.enrich('朋克版ITX电脑DIY教程');
  ok(r && r.ok === true && r.info && r.danmaku === null, '弹幕挂了仍能用详情', r && r.info && r.info.title);

  ok(bili.toPromptText(null) === '' && bili.toPromptText({ ok: false }) === '', '没有数据时给空串（提示词不会脏）');
}

(async () => {
  testMatch();
  await testResolve();
  await testRiskRetry();
  await testDetail();
  await testEnrich();

  console.log('\n通过 ' + PASS.length + ' 项，失败 ' + FAIL.length + ' 项');
  if (FAIL.length) FAIL.forEach((f) => console.log('  × ' + f));
  process.exit(FAIL.length ? 1 : 0);
})();
