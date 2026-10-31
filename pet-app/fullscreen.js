// 全屏判定（纯函数，便于单测）
//
// Windows 上应用进入「真全屏」（游戏、视频全屏、F11、PPT 放映）时会连任务栏一起盖住，
// 此时 Electron 报的 workArea 会等于屏幕 bounds；退出全屏后 workArea 又缩回任务栏高度。
// 这比任何窗口枚举都轻量，也不需要原生模块。
//
// 注意：如果用户把任务栏设成「自动隐藏」，workArea 恒等于 bounds，这个判据就失效了 ——
// 调用方需要在启动时探一次基线，发现失效就退回手动快捷键。
'use strict';

const EPS = 2;   // 容忍 1-2px 的取整误差

function isFullscreenish(workArea, bounds) {
  if (!workArea || !bounds) return false;
  return workArea.width >= bounds.width - EPS && workArea.height >= bounds.height - EPS;
}

module.exports = { isFullscreenish, EPS };
