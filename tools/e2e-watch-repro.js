// 端到端复现：真实 Edge 窗口播 B 站短视频 60 秒，看正在跑的桌宠会不会录
const puppeteer = require('puppeteer-core');
const EDGE = 'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: false,
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1000,640', '--window-position=100,100', '--autoplay-policy=no-user-gesture-required']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 980, height: 600 });
  await page.goto('https://www.bilibili.com/video/BV17snR6TEyG', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));
  // 点播放键兜底（静音自动播）
  try { await page.click('.bpx-player-ctrl-play, video'); } catch (e) { /* ignore */ }
  const state = await page.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { paused: v.paused, muted: v.muted, t: v.currentTime, dur: v.duration, title: document.title } : { noVideo: true };
  });
  console.log('播放状态:', JSON.stringify(state));
  // 循环重播，撑满 60 秒窗口
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await new Promise(r => setTimeout(r, 5000));
    try { await page.evaluate(() => { const v = document.querySelector('video'); if (v && (v.paused || v.ended)) { v.currentTime = 0; v.play(); } }); } catch (e) { /* ignore */ }
  }
  const fin = await page.evaluate(() => { const v = document.querySelector('video'); return v ? { t: v.currentTime, paused: v.paused } : {}; });
  console.log('60 秒后:', JSON.stringify(fin));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('fail:', e.message); process.exit(1); });
