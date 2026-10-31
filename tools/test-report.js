// 陪看报告（PPT）的自动化验收：真的生成一份 pptx，再解包数页数、查文案。
//   node tools/test-report.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const report = require('../pet-app/report');

const PASS = [], FAIL = [];
function ok(cond, msg, extra) {
  (cond ? PASS : FAIL).push(msg + (extra ? '  → ' + extra : ''));
  console.log((cond ? '  ok   ' : '  FAIL ') + msg + (extra ? '   ' + extra : ''));
}

/* ---------------- 造一张真的 PNG 当截图 ---------------- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(file, size) {
  const w = size || 8, h = size || 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x2f);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
  return file;
}

/* ---------------- 假 B 站数据 ---------------- */
function fakeBili() {
  return {
    ok: true,
    bvid: 'BV14Z421g7kk',
    info: {
      bvid: 'BV14Z421g7kk', aid: 1, cid: 2, title: '《朋克版ITX电脑》DIY教程',
      owner: '装机老张', duration: 303, tname: '数码',
      desc: '用废料攒了一台 ITX', stat: { view: 73530, danmaku: 812, like: 82, reply: 12 }
    },
    danmaku: {
      total: 812,
      peaks: [{ from: 250, to: 280, count: 96 }],
      samples: ['这壳子绝了', '高能预警', '反复看了三遍', '大佬收下我的膝盖', '已三连', '我也想做一台']
    }
  };
}

function fakeSession(dir, withBili) {
  const frames = [1, 2, 3, 4].map((i) => ({ i, file: makePng(path.join(dir, 'f' + i + '.png')), at: i * 1000 }));
  const s = {
    id: 'wtest01',
    title: '《朋克版ITX电脑》DIY教程',
    startedAt: Date.parse('2026-10-31T22:00:00+08:00'),
    endedAt: Date.parse('2026-10-31T22:02:00+08:00'),
    frames
  };
  if (withBili) s.bili = fakeBili();
  return s;
}

const ANALYSIS = {
  rating: 7.8,
  verdict: '两分钟看完一套朋克风 ITX 垃圾佬方案：颜值在线、动手感十足。',
  points: ['二手笔记本主板加亚克力外壳', '成本压到极致', '散热用大风扇硬怼'],
  highlights: ['外观设计很有想法', '成本控制得狠'],
  flaws: ['稳定性存疑', '扩展性几乎没有'],
  audience: '喜欢折腾、预算有限的装机爱好者',
  tags: ['ITX', '装机', '垃圾佬']
};

/* ---------------- 解包 pptx 数页数 ---------------- */
async function slideXmls(file) {
  const JSZip = require(path.join(__dirname, '..', 'pet-app', 'node_modules', 'jszip'));
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
  const texts = [];
  for (const n of names) texts.push(await zip.file(n).async('string'));
  return { count: names.length, text: texts.join('\n') };
}

/* ---------------- 1. 小工具 ---------------- */
function testBits() {
  console.log('\n[1] 数字/时间/文件名的小工具');
  ok(report.fmtCount(7353) === '7353', '一万以下原样显示', report.fmtCount(7353));
  ok(report.fmtCount(73530) === '7.4 万', '上万换算成「万」', report.fmtCount(73530));
  ok(report.fmtCount(120000000) === '1.2 亿', '上亿换算成「亿」', report.fmtCount(120000000));
  ok(report.mmss(250) === '04:10', '秒数转 04:10', report.mmss(250));
  ok(report.mmss(0) === '00:00' && report.mmss(9) === '00:09', '补零正确', report.mmss(9));
  ok(report.safeTitle('《朋克版ITX电脑》/ DIY: 教程') === '《朋克版ITX电脑》-DIY-教程',
    '文件名里的非法字符被替换', report.safeTitle('《朋克版ITX电脑》/ DIY: 教程'));

  const base = report.datedBase({ title: '某个视频', startedAt: Date.parse('2026-10-31T10:00:00+08:00') });
  ok(base === '2026-10-31-某个视频', '文件名带日期，天然按时间排序', base);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-name-'));
  fs.writeFileSync(path.join(dir, base + '.pptx'), 'x');
  ok(report.uniqueBase(dir, base) === base + '-2', '同名不会覆盖上一份（自动加 -2）', report.uniqueBase(dir, base));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------- 2. 只出 PPT，不再出长图 ---------------- */
async function testOnlyPptx() {
  console.log('\n[2] 长图功能已删除：只生成 PPT');
  ok(typeof report.summaryHtml === 'undefined', '长图的 HTML 渲染函数已经不在了');
  ok(typeof report.buildSummaryPng === 'undefined', '长图的截图函数已经不在了');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-rep-'));
  const session = fakeSession(dir, true);
  const out = await report.buildReport(session, ANALYSIS, dir);
  ok(!!out.pptx && fs.existsSync(out.pptx), '生成了 pptx', out.pptx && path.basename(out.pptx));
  ok(!('png' in out), '返回结果里没有 png 了');
  ok(fs.readdirSync(dir).filter((n) => /\.png$/i.test(n)).length === 4, '目录里只有原始帧，没有汇总长图',
    fs.readdirSync(dir).filter((n) => /\.png$/i.test(n)).length + ' 张 png（都是采集帧）');
  ok(out.pptx.indexOf('2026-10-31-') >= 0, '报告文件名带日期', path.basename(out.pptx));
  ok(fs.statSync(out.pptx).size > 10000, '文件大小正常', Math.round(fs.statSync(out.pptx).size / 1024) + ' KB');

  // 再来一次同名视频：不能覆盖
  const again = await report.buildReport(session, ANALYSIS, dir);
  ok(again.pptx !== out.pptx && /-2\.pptx$/.test(again.pptx), '同一天同名视频不会互相覆盖', path.basename(again.pptx));

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------- 3. 有 B 站数据时多一页「弹幕」 ---------------- */
async function testSlides() {
  console.log('\n[3] PPT 内容：B 站信息要出现在报告里');

  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-sl-'));
  const noBili = await report.buildReport(fakeSession(dir1, false), ANALYSIS, dir1);
  const a = await slideXmls(noBili.pptx);
  ok(a.count === 6, '没认出视频时 6 页', a.count + ' 页');
  ok(a.text.indexOf('一句话观点') >= 0 && a.text.indexOf('它讲了什么') >= 0, '基本页都在');
  ok(a.text.indexOf('弹幕里在说什么') < 0, '没有 B 站数据就不硬造弹幕页');
  fs.rmSync(dir1, { recursive: true, force: true });

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-sl2-'));
  const withBili = await report.buildReport(fakeSession(dir2, true), ANALYSIS, dir2);
  const b = await slideXmls(withBili.pptx);
  ok(b.count === 7, '认出视频时多一页弹幕现场', b.count + ' 页');
  ok(b.text.indexOf('弹幕里在说什么') >= 0, '有「弹幕里在说什么」这一页');
  ok(b.text.indexOf('装机老张') >= 0, '封面上有 UP 主');
  ok(b.text.indexOf('BV14Z421g7kk') >= 0, '封面上有 BV 号');
  ok(/7\.4 万/.test(b.text), '播放量换算成「万」', (/7\.4 万/.exec(b.text) || [''])[0]);
  ok(b.text.indexOf('这壳子绝了') >= 0, '弹幕抽样进了报告', '「这壳子绝了」');
  ok(/最热闹 04:10/.test(b.text), '标出弹幕最热闹的时间段');
  fs.rmSync(dir2, { recursive: true, force: true });
}

/* ---------------- 4. 缺数据也不崩 ---------------- */
async function testRobust() {
  console.log('\n[4] 数据残缺时照样出报告');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-rb-'));
  const session = { id: 'wx', title: '', frames: [] };
  const out = await report.buildReport(session, null, dir);
  ok(!!out.pptx && fs.existsSync(out.pptx), '没有帧、没有分析也能生成（模板兜底）');
  const s = await slideXmls(out.pptx);
  ok(s.count === 6, '页数不缩水', s.count + ' 页');
  ok(s.text.indexOf('B 站视频') >= 0, '空标题用「B 站视频」兜底');
  fs.rmSync(dir, { recursive: true, force: true });

  ok(report.biliBits(null) === null && report.biliBits({ bili: { ok: false } }) === null,
    '没认出 B 站就返回 null（不会把空数据写进报告）');
  ok(report.biliLine(report.biliBits({ bili: fakeBili() })).indexOf('UP 主 装机老张') >= 0,
    '一行摘要包含 UP 主');
}

(async () => {
  testBits();
  await testOnlyPptx();
  await testSlides();
  await testRobust();

  console.log('\n通过 ' + PASS.length + ' 项，失败 ' + FAIL.length + ' 项');
  if (FAIL.length) FAIL.forEach((f) => console.log('  × ' + f));
  process.exit(FAIL.length ? 1 : 0);
})();
