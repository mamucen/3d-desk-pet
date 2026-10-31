/**
 * 通用工具：转义、时间格式化、Markdown 轻渲染、提示条。
 */
(function () {
  'use strict';

  var K = (window.Keeper = window.Keeper || {});

  /* ---------- 文本 ---------- */

  K.esc = function (value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  K.truncate = function (value, max) {
    var s = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
  };

  /* ---------- 类型与优先级 ---------- */

  K.KIND = {
    thought: { label: '想法', cls: 'k-thought' },
    resource: { label: '资料', cls: 'k-resource' },
    todo: { label: '待办', cls: 'k-todo' }
  };

  K.kindOf = function (kind) {
    return K.KIND[kind] || K.KIND.thought;
  };

  K.PRIORITY = {
    high: { label: '高', cls: 'high' },
    medium: { label: '中', cls: 'medium' },
    low: { label: '低', cls: 'low' }
  };

  /* ---------- 时间 ---------- */

  function toDate(value) {
    if (!value) return null;
    var d = value instanceof Date ? value : new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  K.toDate = toDate;

  K.fmtRelative = function (value) {
    var d = toDate(value);
    if (!d) return '';
    var diff = Date.now() - d.getTime();
    var min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    var hour = Math.floor(min / 60);
    if (hour < 24) return hour + ' 小时前';
    var day = Math.floor(hour / 24);
    if (day === 1) return '昨天';
    if (day < 7) return day + ' 天前';
    return K.fmtDate(d);
  };

  K.fmtDate = function (value) {
    var d = toDate(value);
    if (!d) return '';
    var now = new Date();
    var md = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '年' + md;
  };

  K.fmtDateTime = function (value) {
    var d = toDate(value);
    if (!d) return '';
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    return K.fmtDate(d) + ' ' + hh + ':' + mm;
  };

  /** 待办截止时间的展示：今天 / 明天 / 逾期 */
  K.fmtDue = function (value) {
    var d = toDate(value);
    if (!d) return { text: '', overdue: false };
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var target = new Date(d.getTime());
    target.setHours(0, 0, 0, 0);
    var days = Math.round((target - today) / 86400000);
    var overdue = days < 0;
    var text;
    if (days === 0) text = '今天到期';
    else if (days === 1) text = '明天到期';
    else if (days === -1) text = '昨天逾期';
    else if (days < 0) text = Math.abs(days) + ' 天逾期';
    else if (days <= 7) text = days + ' 天后到期';
    else text = K.fmtDate(d) + ' 到期';
    return { text: text, overdue: overdue };
  };

  /* ---------- 提示 ---------- */

  K.toast = function (message, type) {
    var host = document.getElementById('toasts');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = String(message || '');
    host.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .2s ease, transform .2s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(function () { el.remove(); }, 220);
    }, type === 'err' ? 4200 : 2600);
  };

  /* ---------- Markdown 轻渲染（先转义，再套标签） ---------- */

  function inline(text) {
    return text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  K.md = function (raw) {
    var escaped = K.esc(raw).replace(/\r\n/g, '\n');
    var blocks = escaped.split(/\n{2,}/);
    var html = [];

    blocks.forEach(function (block) {
      var lines = block.split('\n').filter(function (l) { return l.trim() !== ''; });
      if (!lines.length) return;

      if (lines.every(function (l) { return /^\s*[-*•]\s+/.test(l); })) {
        html.push('<ul>' + lines.map(function (l) {
          return '<li>' + inline(l.replace(/^\s*[-*•]\s+/, '')) + '</li>';
        }).join('') + '</ul>');
        return;
      }
      if (lines.every(function (l) { return /^\s*\d+[.)]\s+/.test(l); })) {
        html.push('<ol>' + lines.map(function (l) {
          return '<li>' + inline(l.replace(/^\s*\d+[.)]\s+/, '')) + '</li>';
        }).join('') + '</ol>');
        return;
      }
      if (/^#{1,4}\s+/.test(lines[0])) {
        html.push('<p><strong>' + inline(lines[0].replace(/^#{1,4}\s+/, '')) + '</strong></p>');
        if (lines.length > 1) {
          html.push('<p>' + lines.slice(1).map(inline).join('<br>') + '</p>');
        }
        return;
      }
      html.push('<p>' + lines.map(inline).join('<br>') + '</p>');
    });

    return html.join('');
  };

  /* ---------- 其它 ---------- */

  K.maskUser = function (session) {
    var user = (session && session.user) || {};
    if (user.phone) return String(user.phone).replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
    if (user.email) {
      var parts = String(user.email).split('@');
      var name = parts[0] || '';
      var head = name.slice(0, 2);
      return head + '***@' + (parts[1] || '');
    }
    return user.id ? '我的账号' : '已登录';
  };

  K.debounce = function (fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  };

  /** 从模型输出里取出 JSON（容忍 ```json 包裹与前后多余文字） */
  K.parseJson = function (text) {
    if (!text) return null;
    var s = String(text).trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    try {
      return JSON.parse(s);
    } catch (e) {
      var start = s.indexOf('{');
      var end = s.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { return JSON.parse(s.slice(start, end + 1)); } catch (e2) { return null; }
      }
      return null;
    }
  };

  /** 把任意值规整成字符串数组 */
  K.toArray = function (value) {
    if (Array.isArray(value)) {
      return value.map(function (v) {
        if (v && typeof v === 'object') return v.text || v.title || v.name || '';
        return String(v === null || v === undefined ? '' : v);
      }).map(function (s) { return s.trim(); }).filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
      return value.split(/[,，;；\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
    }
    return [];
  };

  K.escapeHtmlInText = function (s) { return K.esc(s); };
})();
