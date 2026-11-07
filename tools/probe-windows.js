// 诊断用：以桌宠同款方式列出所有窗口标题，并标注 watch.js 的判定结果
const { app, desktopCapturer } = require('electron');
const path = require('path');
app.setPath('userData', path.join(__dirname, '..', '.tmp', 'probe-userdata'));
const { isVideoTitle, cleanTitle } = require(path.join(__dirname, '..', 'pet-app', 'watch.js'));
app.whenReady().then(async () => {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
  console.log('=== 窗口清单（共 ' + sources.length + ' 个）===');
  sources.forEach((s) => {
    const hit = isVideoTitle(s.name);
    console.log((hit ? '[像视频页]' : '[  忽略  ]') + ' ' + JSON.stringify(s.name) + (hit ? '  → 关键词: ' + JSON.stringify(cleanTitle(s.name)) : ''));
  });
  app.exit(0);
}).catch((e) => { console.error('probe fail:', e.message); app.exit(1); });
