// 互动应用目录：预设应用 + 各自的招呼台词。
// 匹配方式只有两种，都是"只读"：
//   1) 窗口标题里包含 keys 里的关键词（主进程用 desktopCapturer 读取标题，纯读取）
//   2) 进程名在 proc 里，且该进程有可见窗口标题
// 不含任何模拟点击/按键能力。
'use strict';

// 这些窗口哪怕标题撞了关键词也不搭理（隐私/系统安全相关）
const NEVER = [
  '防火墙', 'Windows 安全', '安全中心', '病毒和威胁', 'Defender', 'SmartScreen',
  '用户账户控制', 'UAC', '注册表', 'regedit', '组策略', 'BitLocker',
  '磁盘管理', '设备管理器', '系统配置', 'msconfig',
  '凭据', '密码', '支付', '付款', '银行', '转账', '钱包',
  '格式化', '卸载', 'Windows 更新', '任务管理器',
  '命令提示符', 'PowerShell', 'pwsh', 'cmd.exe', 'Terminal', '终端'
];

const APPS = [
  {
    id: 'doubao', name: '豆包', emoji: '🧠', desc: '悬浮窗或主窗口出现时打招呼',
    keys: ['豆包', 'Doubao'], proc: ['Doubao', 'doubao'],
    lines: [
      '豆包来串门了，你们聊什么呢？我不偷看。',
      '咦，同行出现了。我安静待着。',
      '豆包开着呢，那我少说两句。'
    ],
    bye: ['豆包关掉了，回见。']
  },
  {
    id: 'wechat', name: '微信', emoji: '💬', desc: '聊天窗口打开时轻轻提醒',
    keys: ['微信', 'Weixin', 'WeChat'], proc: ['WeChat', 'Weixin'],
    lines: ['有人找你吗？我不看内容。', '微信开着了，回完消息记得歇会儿。', '消息多的话，我帮你看着时间。'],
    bye: ['微信收起来了。']
  },
  {
    id: 'qq', name: 'QQ', emoji: '🐧', desc: 'QQ 窗口出现时',
    keys: ['QQ'], proc: ['QQ', 'QQNT'],
    lines: ['QQ 上线了，有热闹看？', '企鹅来了，我不抢镜。']
  },
  {
    id: 'dingtalk', name: '钉钉', emoji: '📌', desc: '上班族的开工信号',
    keys: ['钉钉', 'DingTalk'], proc: ['DingTalk'],
    lines: ['钉钉开了，要开始忙了吗？', '工作模式启动，我给你盯着时间。'],
    bye: ['钉钉关掉了，今天也辛苦啦。']
  },
  {
    id: 'feishu', name: '飞书', emoji: '📘', desc: '飞书文档/消息窗口',
    keys: ['飞书', 'Feishu', 'Lark'], proc: ['Feishu', 'Lark'],
    lines: ['飞书来了，今天的待办清了吗？', '又在飞书上开会呀。']
  },
  {
    id: 'netease', name: '网易云音乐', emoji: '🎵', desc: '打开就陪你听歌',
    keys: ['网易云', 'CloudMusic'], proc: ['cloudmusic', 'NetEase'],
    lines: ['在听歌呀，我不吵你。', '这首好听吗？我耳朵借你。', '有音乐就没那么累了。'],
    bye: ['音乐停了，耳朵休息一下。']
  },
  {
    id: 'qqmusic', name: 'QQ 音乐', emoji: '🎧', desc: '打开就陪你听歌',
    keys: ['QQ音乐', 'QQMusic'], proc: ['QQMusic'],
    lines: ['QQ 音乐开了，单曲循环吗？', '这歌挺带感的。']
  },
  {
    id: 'bilibili', name: '哔哩哔哩', emoji: '📺', desc: '看视频时自动让开一点',
    keys: ['哔哩哔哩', 'bilibili', 'B站'], proc: ['bilibili'],
    lines: ['看视频啦？我往边上挪挪。', 'B 站开了，这集好看吗？', '记得别看太久哦。'],
    bye: ['视频看完了？眼睛歇会儿。']
  },
  {
    id: 'vscode', name: 'VS Code', emoji: '💻', desc: '写代码时安静陪着你',
    keys: ['Visual Studio Code', 'VS Code', 'Code -'], proc: ['Code'],
    lines: ['写代码呢，我安静点。', '又开 VS Code 了，今天写点什么？', '报错别急，慢慢来。'],
    bye: ['代码写完了？辛苦。']
  },
  {
    id: 'cursor', name: 'Cursor', emoji: '🧭', desc: 'AI 编辑器窗口',
    keys: ['Cursor'], proc: ['Cursor'],
    lines: ['Cursor 开了，你俩配合得怎么样？', 'AI 帮你写代码，我帮你加油。']
  },
  {
    id: 'chrome', name: 'Chrome', emoji: '🌐', desc: '浏览器窗口出现时',
    keys: ['Google Chrome', 'Chrome'], proc: ['chrome'],
    lines: ['标签页是不是又开了一堆…', '又在网上逛呢。'],
    bye: ['浏览器关掉了。']
  },
  {
    id: 'edge', name: 'Edge', emoji: '🌊', desc: '浏览器窗口出现时',
    keys: ['Microsoft Edge', 'Edge'], proc: ['msedge'],
    lines: ['Edge 开了，查资料吗？', '别开太多标签页呀。']
  },
  {
    id: 'steam', name: 'Steam', emoji: '🎮', desc: '一开就祝你玩得开心',
    keys: ['Steam'], proc: ['steam'],
    lines: ['玩得开心点！', '这游戏看着不错，我在旁边看。', '记得玩一会儿就起来动动。'],
    bye: ['不玩了？那歇会儿眼睛。']
  },
  {
    id: 'word', name: 'Word', emoji: '📄', desc: '写文档时',
    keys: ['Microsoft Word', 'Word -', '文档1'], proc: ['WINWORD'],
    lines: ['写文档呀，我帮你盯着字数。', '别写太晚。']
  },
  {
    id: 'excel', name: 'Excel', emoji: '📊', desc: '表格窗口',
    keys: ['Microsoft Excel', 'Excel -', '工作簿'], proc: ['EXCEL'],
    lines: ['表格开了，公式别写错哦。', '这表看着挺复杂。']
  },
  {
    id: 'ppt', name: 'PowerPoint', emoji: '📽️', desc: '做幻灯片的信号',
    keys: ['PowerPoint', '演示文稿'], proc: ['POWERPNT'],
    lines: ['做 PPT 呀，加油。', '演示文稿写完了记得存一下。']
  },
  {
    id: 'capcut', name: '剪映', emoji: '🎬', desc: '剪视频时不来打扰',
    keys: ['剪映', 'CapCut', 'Jianying'], proc: ['JianyingPro', 'CapCut'],
    lines: ['剪视频呢，我不打扰。', '这段剪得挺顺的。']
  },
  {
    id: 'photoshop', name: 'Photoshop', emoji: '🎨', desc: '修图窗口',
    keys: ['Photoshop'], proc: ['Photoshop'],
    lines: ['在修图呀，颜色挺好看。', 'PS 开了，慢慢来。']
  },
  {
    id: 'ybc', name: '猿编程', emoji: '🐒', desc: '与学习模式联动（换肤由学习模式负责）',
    keys: ['猿编程学生端', 'AI IDE', 'ybc', 'YBC'], proc: [],
    lines: ['又见面了，一起写代码吧。', '猿编程开着呢，卡住了就喊我。']
  }
];

// 系统事件（不是窗口，靠只读探针判断）
const SYSTEM_EVENTS = [
  {
    id: 'bt', name: '蓝牙开关', emoji: '📶',
    desc: '蓝牙打开/关闭时提醒（实验性：取决于机型的适配器状态上报）',
    linesOn: ['蓝牙开了，耳机要连吗？', '蓝牙打开了，不用时记得关掉省电。'],
    linesOff: ['蓝牙关了，省电模式启动。', '蓝牙关闭，安静了。']
  }
];

module.exports = { APPS, SYSTEM_EVENTS, NEVER };
