// 诊断用：连续记录窗口标题 + watch.js 判定结果，写 .tmp/probe-log.txt（跑 6 分钟自动退）
const { app, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
app.setPath('userData', path.join(__dirname, '..', '.tmp', 'probe-userdata'));
const { isVideoTitle, cleanTitle } = require(path.join(__dirname, '..', 'pet-app', 'watch.js'));
const LOG = path.join(__dirname, '..', '.tmp', 'probe-log.txt');
const t0 = Date.now();
function log(s) { try { fs.appendFileSync(LOG, s + '\n'); } catch (e) { /* ignore */ } }
log('=== probe start ' + new Date().toLocaleTimeString() + ' ===');
app.whenReady().then(async () => {
  let lastLine = '';
  while (Date.now() - t0 < 15 * 60000) {
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
      const names = sources.map((s) => s.name);
      const line = new Date().toLocaleTimeString() + ' | ' + names.map((n) => (isVideoTitle(n) ? '★' : '·') + n).join(' ┃ ');
      if (line !== lastLine) { log(line); lastLine = line; }
    } catch (e) { log('probe error: ' + e.message); }
    await new Promise((r) => setTimeout(r, 3000));
  }
  log('=== probe end ===');
  app.exit(0);
});
