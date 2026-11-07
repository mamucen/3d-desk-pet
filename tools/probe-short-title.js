// 诊断：打开 B 站短视频页，看 document.title 是否能被 watch.isVideoTitle 认出
const puppeteer = require('puppeteer-core');
const path = require('path');
const bili = require('../pet-app/bili');
const watch = require('../pet-app/watch');
const EDGE = 'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  // 1) 搜几个时长短的横屏视频
  const j = await bili.signedGet('/x/web-interface/wbi/search/type', { search_type: 'video', keyword: '搞笑 猫', page: 1, page_size: 20 });
  const list = (j.data && j.data.result || []).filter(v => v.bvid).slice(0, 20);
  console.log('搜到', list.length, '个候选');
  const shorts = list.filter(v => { const s = bili.toSeconds(v.duration); return s > 20 && s < 300; });
  console.log('其中 20s~5min 的短视频:', shorts.map(v => v.bvid + '(' + v.duration + ')').join(' '));
  if (!shorts.length) { console.log('没筛到短视频，退出'); process.exit(1); }

  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  for (const v of shorts.slice(0, 3)) {
    const url = 'https://www.bilibili.com/video/' + v.bvid;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await new Promise(r => setTimeout(r, 3500));
      const title = await page.title();
      const ok = watch.isVideoTitle(title);
      console.log((ok ? '[认得出]' : '[认不出]') + ' ' + v.bvid + ' dur=' + v.duration);
      console.log('   document.title = ' + JSON.stringify(title));
      console.log('   cleanTitle     = ' + JSON.stringify(watch.cleanTitle(title)));
    } catch (e) { console.log('open fail', v.bvid, e.message); }
  }
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('probe fail:', e.message); process.exit(1); });
