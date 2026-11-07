// 互动应用的台词模板与过滤规则。
// 应用清单不在这里——全部来自本机扫描（开始菜单快捷方式 + 用户手动添加的程序）。
'use strict';

// 这些窗口永不搭理（隐私/系统安全相关）
const NEVER = [
  '防火墙', 'Windows 安全', '安全中心', '病毒和威胁', 'Defender', 'SmartScreen',
  '用户账户控制', 'UAC', '注册表', 'regedit', '组策略', 'BitLocker',
  '磁盘管理', '设备管理器', '系统配置', 'msconfig',
  '凭据', '密码', '支付', '付款', '银行', '转账', '钱包',
  '格式化', '卸载', 'Windows 更新', '任务管理器',
  '命令提示符', 'PowerShell', 'pwsh', 'cmd.exe', 'Terminal', '终端'
];

// 开始菜单里这些快捷方式是系统工具/说明文档，不算"应用"（中英文名都列上）
const SKIP_LNK = [
  '卸载', 'Uninstall', 'Readme', 'README', '说明', '帮助', 'Help',
  '官网', '网站', 'License', '许可', '修复', 'Repair', '更新', 'Update',
  '控制面板', '系统属性', '字符映射表', '映射表', '命令提示符', '注册表', '任务管理器',
  '运行', 'Windows 附件', '辅助工具', 'Windows 轻松使用', '文档', '手册',
  '禁用', '启用', '批准', '开启', '关闭', '日志', '属性', '小键盘',
  '诊断', '疑难解答', '备份', '还原', '恢复', '管理器', '防火墙',
  '此电脑', '计算机', '计算机管理', '控制面板', '服务', '组件服务',
  'Command Prompt', 'Control Panel', 'Computer Management', 'Component Services',
  'Disk Cleanup', 'Defragment', 'Event Viewer', 'Registry Editor', 'Task Scheduler',
  'System Configuration', 'System Information', 'System Restore', 'Resource Monitor',
  'Task Manager', 'Character Map', 'Memory Diagnostic', 'Windows Security',
  'Windows PowerShell', 'Services', 'Run', 'computer', 'This PC'
];

// 台词模板：{name} 会被替换成真实应用名
const LINES = {
  appear: [
    '{name}开着呢，我在旁边。',
    '看到{name}了，需要我帮忙吗？',
    '{name}出现啦。',
    '你在用{name}呀，我安静点。'
  ],
  open: [
    '我去把{name}打开。',
    '{name}这就给你点开。',
    '我过去开一下{name}。'
  ],
  opened: [
    '{name}打开了。',
    '好啦，{name}已经在桌面上了。'
  ],
  sched: [
    '{name}的定时任务到了，我过去打开它。',
    '到点了，我去把{name}打开。'
  ],
  bye: [
    '{name}关掉了。'
  ]
};

function fill(tpl, name) {
  return String(tpl || '').replace(/\{name\}/g, name || '它');
}

function pick(list, name) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return '';
  return fill(arr[Math.floor(Math.random() * arr.length)], name);
}

function isJunkLnk(name) {
  const n = String(name || '').trim();
  if (!n || n.length < 2) return true;                        // 「符」这种截断的系统项
  return SKIP_LNK.some((k) => n.indexOf(k) >= 0);
}

module.exports = { NEVER, SKIP_LNK, LINES, fill, pick, isJunkLnk };
