// 诊断：B 站首页点卡片 → 浮层播放时，document.title 会不会变成视频名
const puppeteer = require('puppeteer-core');
const EDGE = 'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));
  console.log('首页 title:', JSON.stringify(await page.title()));
  // 找首页推荐流里的视频卡片链接
  const clicked = await page.evaluate(() => {
    const cards = document.querySelectorAll('.bili-video-card a[href*="/video/BV"], .feed-card a[href*="/video/BV"]');
    for (const a of cards) {
      if (a.href && a.href.includes('/video/BV')) {
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return a.href;
      }
    }
    return null;
  });
  console.log('点击的卡片:', clicked);
  await new Promise(r => setTimeout(r, 5000));
  console.log('浮层播放 title:', JSON.stringify(await page.title()));
  console.log('当前 URL:', page.url());
  // 再看看页面里有没有浮层播放器
  const hasOverlay = await page.evaluate(() => !!document.querySelector('.bpx-player, .bilibili-player'));
  console.log('页面里有播放器:', hasOverlay);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('fail:', e.message); process.exit(1); });
