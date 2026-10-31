/**
 * 应用主逻辑：启动、鉴权、视图渲染与交互。
 */
(function () {
  'use strict';

  var K = window.Keeper;

  var S = {
    view: 'inbox',
    filter: 'all',
    keyword: '',
    draft: '',
    notes: [],
    todos: [],
    insights: [],
    session: null,
    drawer: null,
    chat: [],
    streaming: null,
    pendingOtp: null,
    period: '7d',
    countdown: 0,
    countdownTimer: null
  };

  function $(id) { return document.getElementById(id); }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /* =========================================================
     启动
     ========================================================= */

  function hideBoot() {
    var boot = $('boot');
    if (boot) boot.classList.add('hidden');
  }

  function failBoot(message) {
    var text = $('bootText');
    if (text) text.textContent = message;
  }

  /* =========================================================
     分享码 / 地址（平台靠 sharecode 放行，缺了会 403「链接不完整」）
     ========================================================= */

  function shareCode() {
    var m = /[?&]sharecode=([^&#]+)/.exec(location.search);
    if (m) return decodeURIComponent(m[1]);
    var pub = (window.PUBLIC_CONFIG || {}).publishedUrl || '';
    m = /[?&]sharecode=([^&#]+)/.exec(pub);
    return m ? decodeURIComponent(m[1]) : '';
  }

  // 干净的页面地址：只保留 sharecode，丢掉 code/state 等一次性参数
  function cleanUrl() {
    var sc = shareCode();
    return location.pathname + (sc ? '?sharecode=' + encodeURIComponent(sc) : '');
  }

  // 微信授权回调地址：必须带 sharecode，
  // 否则中转站把浏览器送回裸域名，平台直接 403「链接不完整」（用户看到的“失效”）
  function oauthRedirectTo() {
    var sc = shareCode();
    return location.origin + location.pathname + (sc ? '?sharecode=' + encodeURIComponent(sc) : '');
  }

  function wechatErrorText(msg) {
    var m = String(msg || '');
    if (/expired|超时|invalid or expired/i.test(m)) {
      return '微信登录已超时（二维码有效期约 5 分钟），请重新点「微信登录」再扫一次。';
    }
    if (/state/i.test(m)) return '微信登录状态校验失败，请重新点「微信登录」。';
    if (/denied|cancel/i.test(m)) return '微信登录被取消，可以再试一次。';
    if (!m) return '微信登录未完成，请重试。';
    return '微信登录未完成：' + m;
  }

  async function boot() {
    if (window.__cloudInitError) return failBoot(window.__cloudInitError);
    if (!window.cloud) return failBoot('云服务初始化失败，请刷新页面重试。');

    bindAuthEvents();
    bindShellEvents();
    bindDrawerEvents();

    // 微信回调必须在任何路由守卫之前处理
    var cbError = null;
    try {
      var cb = await window.cloud.auth.handleWechatWebCallback();
      if (cb && cb.data) {
        // 登录成功：把地址洗回“只有 sharecode”的样子，别把 code/state 留在地址栏
        history.replaceState(null, '', cleanUrl());
      } else if (cb && cb.error) {
        cbError = cb.error;
      }
    } catch (err) {
      cbError = { message: (err && err.message) || '' };
    }

    var res = await safeSession();
    if (res) {
      if (cbError) history.replaceState(null, '', cleanUrl());
      enterApp(res);
    } else {
      showAuth();
      hideBoot();
      // 已经有会话就不必吓唬用户；真没登录上才提示
      if (cbError) setText('wechatError', wechatErrorText(cbError.message));
    }

    window.cloud.auth.onAuthStateChange(function (event) {
      if (event === 'SIGNED_OUT') {
        S.session = null;
        showAuth();
      }
    });
  }

  async function safeSession() {
    try {
      var res = await window.cloud.auth.getSession();
      if (res && res.error) return null;
      return res && res.data ? res.data : null;
    } catch (err) {
      return null;
    }
  }

  function setText(id, text) {
    var el = $(id);
    if (el) el.textContent = text || '';
  }

  /* =========================================================
     鉴权
     ========================================================= */

  function showAuth() {
    $('auth').classList.remove('hidden');
    $('app').classList.add('hidden');
    $('drawer').classList.add('hidden');
    addOriginNote();
    hideBoot();
  }

  function enterApp(session) {
    S.session = session;
    $('auth').classList.add('hidden');
    $('app').classList.remove('hidden');

    var label = K.maskUser(session);
    setText('userName', label);
    setText('userSub', '云端同步已开启');
    var av = $('avatar');
    if (av) av.textContent = label.slice(0, 1) || '我';

    hideBoot();
    switchView('inbox', true);
    updateTodoBadge();
    loadTodos(true);            // 静默拉一次待办，桌面小机器人和角标都要用
    if (K.pet && K.pet.start) K.pet.start();
  }

  async function updateTodoBadge() {
    try {
      var count = await K.db.countOpenTodos();
      var el = $('todoCount');
      if (el) el.textContent = count ? String(count) : '';
    } catch (err) { /* 角标失败不影响主流程 */ }
  }

  /** 是否运行在发布地址上（微信登录只允许发布地址发起，平台侧校验来源） */
  function isPublishedOrigin() {
    var pub = (window.PUBLIC_CONFIG || {}).publishedUrl || '';
    var base = pub.split('?')[0].replace(/\/+$/, '');
    return !!base && location.origin === base;
  }

  /** 本地预览时，在登录卡片顶部放一条指引，避免用户撞上平台报错 */
  function addOriginNote() {
    if (isPublishedOrigin()) return;
    var card = qs('.auth-card');
    if (!card || qs('.origin-note', card)) return;
    var pub = (window.PUBLIC_CONFIG || {}).publishedUrl || '';
    var note = document.createElement('div');
    note.className = 'origin-note';
    note.innerHTML =
      '你现在打开的是<b>本地预览</b>，微信登录在这里用不了（平台要求从发布地址发起）。' +
      (pub
        ? '<a href="' + K.esc(pub) + '" target="_blank" rel="noopener">点这里用发布地址打开信息管家</a>，'
        : '') +
      '或改用手机号验证码登录。';
    card.insertBefore(note, card.firstChild);
  }

  function bindAuthEvents() {
    var tabs = $('authTabs');
    if (tabs) {
      tabs.addEventListener('click', function (e) {
        var tab = e.target.closest('.auth-tab');
        if (!tab) return;
        qsa('.auth-tab', tabs).forEach(function (t) { t.classList.remove('is-active'); });
        tab.classList.add('is-active');
        var method = tab.getAttribute('data-method');
        $('phoneForm').classList.toggle('hidden', method !== 'phone');
        $('wechatPane').classList.toggle('hidden', method !== 'wechat');
        setText('authError', '');
        setText('wechatError', '');
      });
    }

    var phone = $('phone');
    if (phone) {
      phone.addEventListener('input', function () {
        setText('phoneError', '');
        setText('authError', '');
      });
    }

    var sendBtn = $('sendCode');
    if (sendBtn) sendBtn.addEventListener('click', sendCode);

    var form = $('phoneForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        submitPhoneLogin();
      });
    }

    var wechatBtn = $('wechatBtn');
    if (wechatBtn) {
      wechatBtn.addEventListener('click', async function () {
        if (!isPublishedOrigin()) {
          setText('wechatError', '微信登录需要在发布地址上进行（当前是本地预览）。请点上方链接用发布地址打开，或改用手机号登录。');
          return;
        }
        setText('wechatError', '');
        wechatBtn.disabled = true;
        try {
          var res = await window.cloud.auth.signInWithOAuth({
            provider: 'wechat',
            redirectTo: oauthRedirectTo()
          });
          if (res.error) {
            setText('wechatError', res.error.message || '微信登录发起失败，请改用手机号登录');
            return;
          }
          location.assign(res.data.url);
        } catch (err) {
          setText('wechatError', (err && err.message) || '微信登录发起失败，请改用手机号登录');
        } finally {
          wechatBtn.disabled = false;
        }
      });
    }
  }

  function startCountdown() {
    var btn = $('sendCode');
    if (!btn) return;
    S.countdown = 60;
    btn.disabled = true;
    btn.textContent = S.countdown + ' 秒后重发';
    clearInterval(S.countdownTimer);
    S.countdownTimer = setInterval(function () {
      S.countdown -= 1;
      if (S.countdown <= 0) {
        clearInterval(S.countdownTimer);
        btn.disabled = false;
        btn.textContent = '获取验证码';
        return;
      }
      btn.textContent = S.countdown + ' 秒后重发';
    }, 1000);
  }

  async function sendCode() {
    var phone = ($('phone').value || '').trim();
    if (!/^1\d{10}$/.test(phone)) {
      setText('phoneError', '请输入正确的 11 位手机号');
      return;
    }
    setText('phoneError', '');
    setText('authError', '');

    var btn = $('sendCode');
    btn.disabled = true;
    btn.textContent = '发送中…';
    try {
      var res = await window.cloud.auth.sendOtp({ phone: phone });
      if (res.error) {
        btn.disabled = false;
        btn.textContent = '获取验证码';
        setText('authError', res.error.message || '验证码发送失败，请稍后重试');
        return;
      }
      S.pendingOtp = {
        phone: phone,
        verificationId: res.data.verificationId,
        isExistingUser: res.data.isExistingUser
      };
      startCountdown();
      K.toast('验证码已发送，请查收短信', 'ok');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '获取验证码';
      setText('authError', (err && err.message) || '验证码发送失败，请稍后重试');
    }
  }

  async function submitPhoneLogin() {
    var phone = ($('phone').value || '').trim();
    var code = ($('code').value || '').trim();
    if (!/^1\d{10}$/.test(phone)) {
      setText('phoneError', '请输入正确的 11 位手机号');
      return;
    }
    var pending = S.pendingOtp;
    if (!pending || pending.phone !== phone) {
      setText('authError', '请先获取当前手机号的验证码');
      return;
    }
    if (!/^\d{4,6}$/.test(code)) {
      setText('authError', '请输入收到的验证码');
      return;
    }

    var btn = $('loginBtn');
    btn.disabled = true;
    btn.textContent = '登录中…';
    setText('authError', '');
    try {
      var res = await window.cloud.auth.verifyOtp({
        phone: pending.phone,
        verificationId: pending.verificationId,
        isExistingUser: pending.isExistingUser,
        token: code
      });
      if (res.error) {
        setText('authError', res.error.message || '验证码不正确，请重试');
        return;
      }
      S.pendingOtp = null;
      var session = await safeSession();
      if (!session) {
        var payload = res.data || {};
        session = { user: payload.user || (payload.session && payload.session.user) || null };
      }
      enterApp(session);
    } catch (err) {
      setText('authError', (err && err.message) || '登录失败，请重试');
    } finally {
      btn.disabled = false;
      btn.textContent = '登录 / 注册';
    }
  }

  /* =========================================================
     外壳与导航
     ========================================================= */

  function bindShellEvents() {
    var nav = $('nav');
    if (nav) {
      nav.addEventListener('click', function (e) {
        var item = e.target.closest('.nav-item');
        if (!item) return;
        switchView(item.getAttribute('data-view'));
        $('app').classList.remove('nav-open');
      });
    }

    var menuBtn = $('menuBtn');
    if (menuBtn) {
      menuBtn.addEventListener('click', function () {
        $('app').classList.toggle('nav-open');
      });
    }

    var signOut = $('signOut');
    if (signOut) {
      signOut.addEventListener('click', async function () {
        signOut.disabled = true;
        try { await window.cloud.auth.signOut(); } catch (err) { /* 忽略 */ }
        signOut.disabled = false;
        S.session = null;
        S.notes = []; S.todos = []; S.insights = []; S.chat = [];
        if (K.pet && K.pet.stop) K.pet.stop();
        showAuth();
      });
    }

    var search = $('search');
    if (search) {
      var run = K.debounce(function () {
        S.keyword = search.value.trim();
        var clear = $('searchClear');
        if (clear) clear.classList.toggle('hidden', !S.keyword);
        if (S.view !== 'inbox') switchView('inbox');
        else refreshInbox();
      }, 340);
      search.addEventListener('input', run);
    }

    var clear = $('searchClear');
    if (clear) {
      clear.addEventListener('click', function () {
        $('search').value = '';
        S.keyword = '';
        clear.classList.add('hidden');
        refreshInbox();
      });
    }

    var view = $('view');
    view.addEventListener('click', onViewClick);
    view.addEventListener('keydown', onViewKeydown);
    view.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'capture') {
        S.draft = e.target.value;
        autoGrow(e.target);
      }
      if (e.target && e.target.id === 'askInput') autoGrow(e.target);
    });
  }

  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 320) + 'px';
  }

  function setSyncBusy(busy) {
    var el = $('syncState');
    if (!el) return;
    el.textContent = busy ? '同步中…' : '已同步';
    el.classList.toggle('is-busy', !!busy);
  }

  function switchView(name, force) {
    if (S.view === name && !force) return;
    S.view = name;
    qsa('.nav-item').forEach(function (item) {
      item.classList.toggle('is-active', item.getAttribute('data-view') === name);
    });
    render();
    if (name === 'inbox') refreshInbox();
    if (name === 'todo') loadTodos();
    if (name === 'insights') loadInsights();
    if (name === 'ask') renderAsk();
  }

  function render() {
    if (!S.session) return;
    if (S.view === 'inbox') renderInbox();
    else if (S.view === 'todo') renderTodo();
    else if (S.view === 'ask') renderAsk();
    else if (S.view === 'insights') renderInsights();
  }

  /* =========================================================
     收件箱
     ========================================================= */

  async function refreshInbox() {
    setSyncBusy(true);
    try {
      var opts = { limit: S.keyword ? 60 : 200 };
      if (S.filter !== 'all') opts.kind = S.filter;
      if (S.keyword) opts.keyword = S.keyword;
      S.notes = await K.db.listNotes(opts);
      renderInbox();
      petSync();
    } catch (err) {
      K.toast(err.message || '记录加载失败', 'err');
      var list = $('noteList');
      if (list) list.innerHTML = errorState(err.message);
    } finally {
      setSyncBusy(false);
    }
  }

  function renderInbox() {
    var view = $('view');
    if (!view) return;

    var active = document.activeElement;
    var keepFocus = !!(active && active.id === 'capture');
    var caret = keepFocus ? active.selectionStart : 0;

    var filters = [
      { key: 'all', label: '全部' },
      { key: 'thought', label: '想法' },
      { key: 'resource', label: '资料' },
      { key: 'todo', label: '待办' }
    ];

    view.innerHTML = '' +
      '<div class="view-inner">' +
        '<header class="page-head">' +
          '<h2>收件箱</h2>' +
          '<p>想到什么就先记下来，剩下的交给它整理。</p>' +
        '</header>' +

        '<div class="composer">' +
          '<textarea id="capture" placeholder="记点什么… 一句想法、一段资料、一件待办"></textarea>' +
          '<div class="composer-bar">' +
            '<span class="hint"><span class="dot"></span>AI 会自动分类、摘要并关联已有内容</span>' +
            '<span class="kbd">⌘ / Ctrl + Enter</span>' +
            '<button class="btn primary" data-act="capture" type="button">收下</button>' +
          '</div>' +
        '</div>' +

        '<div class="filters">' +
          filters.map(function (f) {
            return '<button class="chip' + (S.filter === f.key ? ' is-active' : '') +
              '" data-act="filter" data-kind="' + f.key + '">' + f.label + '</button>';
          }).join('') +
          '<div class="list-controls">' +
            '<span class="sort-label">共 ' + S.notes.length + ' 条' +
              (S.keyword ? '（搜索：' + K.esc(S.keyword) + '）' : '') + '</span>' +
          '</div>' +
        '</div>' +

        '<div class="list" id="noteList">' + renderNoteList() + '</div>' +
      '</div>';

    var capture = $('capture');
    if (capture) {
      capture.value = S.draft || '';
      autoGrow(capture);
      if (keepFocus) {
        capture.focus();
        try { capture.setSelectionRange(caret, caret); } catch (e) { /* 忽略 */ }
      }
    }
  }

  function renderNoteList() {
    if (!S.notes.length) {
      if (S.keyword) {
        return emptyState('没有匹配的记录',
          '换个关键词试试，或者直接在顶部清空搜索。');
      }
      return emptyState('收件箱还是空的',
        '把脑子里的念头、看到的资料、要做的事先丢进来，AI 会替你分门别类。');
    }
    return S.notes.map(noteCard).join('');
  }

  function noteCard(note) {
    var kind = K.kindOf(note.kind);
    var tags = (note.tags || []).slice(0, 4);
    var due = K.fmtDue(note.due_at);
    var isDone = note.status === 'done';
    var summary = note.summary || K.truncate(note.content, 96);

    return '' +
      '<article class="note-card ' + kind.cls + (isDone ? ' done' : '') + '" data-act="open" data-id="' + note.id + '">' +
        '<div class="note-top">' +
          (note.kind === 'todo'
            ? '<button class="check' + (isDone ? ' on' : '') + '" data-act="toggle" data-id="' + note.id + '" aria-label="完成">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg></button>'
            : '') +
          '<span class="pill ' + kind.cls + '">' + kind.label + '</span>' +
          (note.category ? '<span class="pill cat">' + K.esc(note.category) + '</span>' : '') +
          (note.ai_state === 'pending' ? '<span class="pill warn">AI 整理中</span>' : '') +
          (note.ai_state === 'failed' ? '<span class="pill danger">待重新整理</span>' : '') +
          (isDone ? '<span class="pill done">已完成</span>' : '') +
          '<span class="note-time">' + K.fmtRelative(note.created_at) + '</span>' +
        '</div>' +
        '<h3 class="note-title">' + K.esc(note.title || K.truncate(note.content, 26)) + '</h3>' +
        '<p class="note-summary">' + K.esc(summary) + '</p>' +
        (tags.length
          ? '<div class="note-tags">' + tags.map(function (t) {
              return '<span class="tag">#' + K.esc(t) + '</span>';
            }).join('') + '</div>'
          : '') +
        '<div class="note-foot">' +
          (note.kind === 'todo'
            ? '<span class="metric">' +
                '<span class="prio-dot ' + ((K.PRIORITY[note.priority] || {}).cls || '') + '"></span>' +
                ((K.PRIORITY[note.priority] || {}).label || '未定') + '优先级</span>'
            : '') +
          (due.text ? '<span class="due' + (due.overdue ? ' overdue' : '') + '">' + due.text + '</span>' : '') +
          ((note.key_points || []).length
            ? '<span class="metric">' + (note.key_points || []).length + ' 条要点</span>' : '') +
          ((note.related_ids || []).length
            ? '<span class="metric">' + note.related_ids.length + ' 条关联</span>' : '') +
        '</div>' +
      '</article>';
  }

  function emptyState(title, desc) {
    return '' +
      '<div class="empty">' +
        '<div class="empty-art">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M5 4.5h9.5L19 9v10.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1Z"/>' +
            '<path d="M14 4.5V9h4.5M8.5 13h7M8.5 16.5h4.5"/>' +
          '</svg>' +
        '</div>' +
        '<h3>' + K.esc(title) + '</h3>' +
        '<p>' + K.esc(desc) + '</p>' +
      '</div>';
  }

  function errorState(message) {
    return '' +
      '<div class="empty">' +
        '<div class="empty-art" style="background:#fbeaed;color:#c1445a">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
            '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 16h.01"/></svg>' +
        '</div>' +
        '<h3>加载失败</h3>' +
        '<p>' + K.esc(message || '请稍后重试') + '</p>' +
      '</div>';
  }

  async function capture() {
    var input = $('capture');
    if (!input) return;
    var text = (input.value || '').trim();
    if (!text) {
      K.toast('先写点什么吧');
      input.focus();
      return;
    }

    var btn = qs('[data-act="capture"]');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }

    try {
      var note = await K.db.createNote({ content: text });
      S.draft = '';
      await refreshInbox();
      var again = $('capture');
      if (again) { again.value = ''; autoGrow(again); again.focus(); }
      K.toast('已收下，正在整理…', 'ok');
      enrich(note);
    } catch (err) {
      K.toast(err.message || '保存失败', 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '收下'; }
    }
  }

  async function enrich(note) {
    if (!K.ai.available()) {
      updateLocal(note.id, { ai_state: 'failed' });
      render();
      return;
    }
    try {
      var pool = S.notes.length ? S.notes : await K.db.listNotes({ limit: 40 });
      var candidates = pool.filter(function (n) { return n.id !== note.id; }).slice(0, 40);
      var result = await K.ai.analyzeNote(note, candidates);

      var updated = await K.db.updateNote(note.id, {
        title: result.title,
        kind: result.kind,
        category: result.category,
        summary: result.summary,
        key_points: result.key_points,
        tags: result.tags,
        priority: result.priority || null,
        due_at: result.due_at || null,
        related_ids: result.related_ids,
        ai_state: 'done'
      });

      updateLocal(updated.id, updated);
      render();
      if (S.drawer && S.drawer.id === updated.id) {
        S.drawer = updated;
        renderDrawer(updated, result.related_reasons);
      }
      if (result.related_ids.length) {
        K.toast('已归类，并找到 ' + result.related_ids.length + ' 条相关旧记录', 'ok');
      }

      // 同步给桌面小机器人：待办数可能变了，顺便让它播报归类结果
      if (updated.kind === 'todo' && S.view !== 'todo') loadTodos(true);
      if (K.pet && K.pet.event) {
        K.pet.event({
          type: 'analyzed',
          kind: updated.kind,
          title: updated.title || K.truncate(updated.content, 20),
          category: updated.category || '',
          tags: (updated.tags || []).slice(0, 2),
          related: (result.related_ids || []).length
        });
      }
    } catch (err) {
      try {
        var failed = await K.db.updateNote(note.id, { ai_state: 'failed' });
        updateLocal(failed.id, failed);
      } catch (e2) { /* 保持原样 */ }
      render();
      K.toast('AI 整理失败：' + (err.message || '请稍后重试'), 'err');
    }
  }

  function updateLocal(id, patch) {
    [S.notes, S.todos].forEach(function (arr) {
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].id === id) {
          arr[i] = typeof patch === 'object' ? Object.assign({}, arr[i], patch) : arr[i];
          return;
        }
      }
    });
  }

  /* =========================================================
     待办
     ========================================================= */

  async function loadTodos(silent) {
    setSyncBusy(true);
    try {
      S.todos = await K.db.listNotes({ kind: 'todo', limit: 200 });
      if (!silent) renderTodo();
      updateTodoCount();
    } catch (err) {
      K.toast(err.message || '待办加载失败', 'err');
    } finally {
      setSyncBusy(false);
    }
  }

  /** 通知桌面小机器人：状态变了 */
  function petSync(force) {
    try {
      if (K.pet && K.pet.sync) K.pet.sync(force);
    } catch (err) { /* 联动失败不影响主流程 */ }
  }

  function updateTodoCount() {
    var el = $('todoCount');
    if (el) {
      var open = S.todos.filter(function (t) { return t.status !== 'done'; }).length;
      el.textContent = open ? String(open) : '';
    }
    petSync();
  }

  function todoBuckets() {
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    var buckets = { overdue: [], today: [], upcoming: [], someday: [], done: [] };

    S.todos.forEach(function (t) {
      if (t.status === 'done') { buckets.done.push(t); return; }
      if (!t.due_at) { buckets.someday.push(t); return; }
      var d = K.toDate(t.due_at);
      if (!d) { buckets.someday.push(t); return; }
      var target = new Date(d.getTime());
      target.setHours(0, 0, 0, 0);
      var diff = Math.round((target - now) / 86400000);
      if (diff < 0) buckets.overdue.push(t);
      else if (diff === 0) buckets.today.push(t);
      else if (diff <= 7) buckets.upcoming.push(t);
      else buckets.someday.push(t);
    });

    var weight = { high: 0, medium: 1, low: 2, '': 3 };
    function sorter(a, b) {
      var wa = weight[a.priority || ''] ?? 3;
      var wb = weight[b.priority || ''] ?? 3;
      if (wa !== wb) return wa - wb;
      var da = a.due_at ? new Date(a.due_at).getTime() : Infinity;
      var dbb = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      return da - dbb;
    }
    ['overdue', 'today', 'upcoming', 'someday'].forEach(function (k) { buckets[k].sort(sorter); });
    return buckets;
  }

  function renderTodo() {
    var view = $('view');
    if (!view) return;

    var b = todoBuckets();
    var open = b.overdue.length + b.today.length + b.upcoming.length + b.someday.length;

    var groups = [
      { key: 'overdue', label: '已逾期', items: b.overdue },
      { key: 'today', label: '今天到期', items: b.today },
      { key: 'upcoming', label: '接下来七天', items: b.upcoming },
      { key: 'someday', label: '未设时间', items: b.someday },
      { key: 'done', label: '已完成', items: b.done }
    ];

    var groupsHtml = groups.filter(function (g) { return g.items.length; }).map(function (g) {
      return '<div class="todo-group-title">' + g.label + '（' + g.items.length + '）</div>' +
        '<div class="list">' + g.items.map(noteCard).join('') + '</div>';
    }).join('');

    view.innerHTML = '' +
      '<div class="view-inner">' +
        '<header class="page-head">' +
          '<h2>待办</h2>' +
          '<p>从记录中识别出的任务，按优先级和时间自动排好。</p>' +
        '</header>' +

        '<div class="todo-stats">' +
          '<div class="stat"><b>' + open + '</b><small>待处理</small></div>' +
          '<div class="stat warn"><b>' + b.overdue.length + '</b><small>已逾期</small></div>' +
          '<div class="stat"><b>' + b.today.length + '</b><small>今天到期</small></div>' +
          '<div class="stat"><b>' + b.done.length + '</b><small>已完成</small></div>' +
        '</div>' +

        '<div class="gen-card">' +
          '<div class="gen-row">' +
            '<div class="grow">' +
              '<h3>让 AI 整理一遍待办</h3>' +
              '<p>合并重复的任务、补全含糊的描述，并给出今天最该推进的几件事。</p>' +
            '</div>' +
            '<button class="btn primary" data-act="organize" type="button"' +
              (open ? '' : ' disabled') + '>整理待办</button>' +
          '</div>' +
          '<div id="todoAI"></div>' +
        '</div>' +

        (open + b.done.length === 0
          ? emptyState('还没有待办',
              '在收件箱里记录“要做什么”，AI 会自动把它识别成待办并给出优先级。')
          : groupsHtml) +
      '</div>';
  }

  async function toggleTodo(id) {
    var note = S.todos.concat(S.notes).filter(function (n) { return n.id === id; })[0];
    if (!note) return;
    var next = note.status === 'done' ? 'inbox' : 'done';
    try {
      var updated = await K.db.updateNote(id, { status: next });
      updateLocal(id, updated);
      if (S.view === 'todo') { await loadTodos(); }
      else { render(); }
      updateTodoBadge();
      if (next === 'done') K.toast('已完成 ✓', 'ok');
    } catch (err) {
      K.toast(err.message || '更新失败', 'err');
    }
  }

  async function organizeTodos() {
    var open = S.todos.filter(function (t) { return t.status !== 'done'; });
    if (!open.length) {
      K.toast('没有待处理的待办');
      return;
    }
    var host = $('todoAI');
    if (!host) return;
    host.innerHTML = '<div class="ai-panel"><h3>正在整理…</h3><p class="ov">' +
      '<span class="typing"><span></span><span></span><span></span></span></p></div>';

    var btn = qs('[data-act="organize"]');
    if (btn) btn.disabled = true;

    try {
      var result = await K.ai.organizeTodos(open);
      host.innerHTML = '' +
        '<div class="ai-panel">' +
          '<h3>' + K.esc(result.overview || '整理结果') + '</h3>' +
          (result.groups.length
            ? result.groups.map(function (g) {
                return '<div class="ai-group"><h5>' + K.esc(g.name) + '</h5><ul>' +
                  g.items.map(function (i) { return '<li>' + K.esc(i) + '</li>'; }).join('') +
                  '</ul></div>';
              }).join('')
            : '') +
          (result.next_actions.length
            ? '<div class="ai-next"><h5>今天最该推进</h5><ol>' +
                result.next_actions.map(function (a) { return '<li>' + K.esc(a) + '</li>'; }).join('') +
              '</ol></div>'
            : '') +
          (result.risks.length
            ? '<div class="ai-next"><h5>需要注意</h5><ul>' +
                result.risks.map(function (r) { return '<li>' + K.esc(r) + '</li>'; }).join('') +
              '</ul></div>'
            : '') +
        '</div>';
    } catch (err) {
      host.innerHTML = '';
      K.toast(err.message || '整理失败', 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* =========================================================
     智能问答
     ========================================================= */

  var SUGGESTS = [
    '我最近在关注什么？',
    '有哪些事情我一直没推进？',
    '帮我总结一下关于产品的想法',
    '我记录过哪些值得回看的资料？'
  ];

  function renderAsk() {
    var view = $('view');
    if (!view) return;

    var hero = S.chat.length ? '' : '' +
      '<div class="ask-hero">' +
        '<h2>问问你的记录</h2>' +
        '<p>它只会基于你自己记录的内容回答，并标注引用了哪几条。</p>' +
        '<div class="suggest-row">' +
          SUGGESTS.map(function (q) {
            return '<button class="suggest" data-act="suggest" data-q="' + K.esc(q) + '">' + K.esc(q) + '</button>';
          }).join('') +
        '</div>' +
      '</div>';

    view.innerHTML = '' +
      '<div class="view-inner ask-wrap">' +
        hero +
        '<div class="chat" id="chat">' + S.chat.map(renderMessage).join('') + '</div>' +
        '<div class="ask-input">' +
          '<div class="ask-box">' +
            '<textarea id="askInput" rows="1" placeholder="例如：我这周在产品上想了些什么？"></textarea>' +
            (S.streaming
              ? '<button class="send" data-act="stop" type="button" aria-label="停止">' +
                  '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg></button>'
              : '<button class="send" data-act="send" type="button" aria-label="发送">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M12 5.5 18.5 12 12 18.5"/></svg></button>') +
          '</div>' +
          '<p class="ask-hint">回答基于你已有的记录，记录越具体，答案越有用。</p>' +
        '</div>' +
      '</div>';

    scrollChatToEnd();
  }

  function renderMessage(msg, index) {
    if (msg.role === 'user') {
      return '' +
        '<div class="msg user" data-msg="' + index + '">' +
          '<div class="bubble-wrap"><div class="who">我</div>' +
            '<div class="bubble">' + K.esc(msg.content) + '</div></div>' +
          '<div class="avatar-q">我</div>' +
        '</div>';
    }
    var body = msg.pending
      ? '<span class="typing"><span></span><span></span><span></span></span>'
      : K.md(msg.content || '');
    return '' +
      '<div class="msg ai" data-msg="' + index + '">' +
        '<div class="avatar-q">AI</div>' +
        '<div class="bubble-wrap">' +
          '<div class="who">信息管家</div>' +
          '<div class="bubble">' + body + '</div>' +
          '<div class="sources" data-sources="' + index + '">' + renderSources(msg.sources) + '</div>' +
        '</div>' +
      '</div>';
  }

  function renderSources(sources) {
    if (!sources || !sources.length) return '';
    return sources.map(function (s, i) {
      return '<button class="source-chip" data-act="open" data-id="' + s.id + '">[' + (i + 1) + '] ' +
        K.esc(K.truncate(s.title, 18)) + '</button>';
    }).join('');
  }

  function scrollChatToEnd() {
    var view = $('view');
    if (view) view.scrollTop = view.scrollHeight;
  }

  function tokenize(text) {
    var lowered = String(text || '').toLowerCase();
    var latin = lowered.match(/[a-z0-9_]{2,}/g) || [];
    var cjkSegments = lowered.replace(/[^\u4e00-\u9fa5]/g, ' ').split(/\s+/).filter(Boolean);
    var grams = [];
    cjkSegments.forEach(function (seg) {
      if (seg.length === 2) grams.push(seg);
      else if (seg.length > 2) {
        for (var i = 0; i < seg.length - 1; i++) grams.push(seg.slice(i, i + 2));
      }
    });
    var stop = ['我的', '什么', '怎么', '哪些', '一下', '这个', '那个', '可以', '有没', '没有', '最近'];
    return Array.from(new Set(latin.concat(grams))).filter(function (t) {
      return stop.indexOf(t) < 0;
    });
  }

  function pickContext(question, notes) {
    var terms = tokenize(question);
    var scored = notes.map(function (n) {
      var title = (n.title || '').toLowerCase();
      var summary = (n.summary || '').toLowerCase();
      var content = (n.content || '').toLowerCase();
      var tags = (n.tags || []).join(' ').toLowerCase();
      var s = 0;
      terms.forEach(function (t) {
        if (title.indexOf(t) >= 0) s += 4;
        if (tags.indexOf(t) >= 0) s += 3;
        if (summary.indexOf(t) >= 0) s += 2;
        if (content.indexOf(t) >= 0) s += 1;
      });
      var d = K.toDate(n.created_at);
      if (d) {
        var days = (Date.now() - d.getTime()) / 86400000;
        s += Math.max(0, 1.5 - days / 30);
      }
      return { n: n, s: s };
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    var picked = scored.filter(function (x) { return x.s >= 2; }).slice(0, 10).map(function (x) { return x.n; });
    if (picked.length < 4) {
      notes.slice(0, 8).forEach(function (n) {
        if (picked.length < 8 && picked.indexOf(n) < 0) picked.push(n);
      });
    }
    return picked.slice(0, 10);
  }

  async function sendQuestion(question) {
    var q = String(question || '').trim();
    if (!q || S.streaming) return;

    var input = $('askInput');
    if (input) input.value = '';

    S.chat.push({ role: 'user', content: q });
    var aiIndex = S.chat.length;
    S.chat.push({ role: 'ai', content: '', sources: [], pending: true });
    renderAsk();

    var controller = new AbortController();
    S.streaming = controller;

    var bubble = qs('[data-msg="' + aiIndex + '"] .bubble');
    var sourcesHost = qs('[data-sources="' + aiIndex + '"]');
    var answer = '';
    var frame = null;

    function paint() {
      if (!bubble) return;
      bubble.innerHTML = K.md(answer);
      scrollChatToEnd();
    }

    function schedulePaint() {
      if (frame) return;
      frame = requestAnimationFrame(function () { frame = null; paint(); });
    }

    try {
      var pool = await K.db.listNotes({ limit: 200 });
      var context = pickContext(q, pool);

      if (!context.length) {
        answer = '你的记录里还没有内容，我暂时无从回答。先去收件箱记几条，再回来问我吧。';
        paint();
        S.chat[aiIndex] = { role: 'ai', content: answer, sources: [] };
        finishAsk();
        return;
      }

      var history = S.chat.slice(0, aiIndex)
        .filter(function (m) { return m.role === 'user' && !m.pending; })
        .slice(-3)
        .map(function (m) { return '（前一个问题）' + m.content; })
        .join('\n');
      var fullQuestion = history ? history + '\n（现在的问题）' + q : q;

      await K.ai.answer(fullQuestion, context, {
        signal: controller.signal,
        onDelta: function (delta) {
          answer += delta;
          schedulePaint();
        }
      });

      S.chat[aiIndex] = {
        role: 'ai',
        content: answer,
        sources: context.map(function (n) {
          return { id: n.id, title: n.title || K.truncate(n.content, 18) };
        })
      };
      if (sourcesHost) sourcesHost.innerHTML = renderSources(S.chat[aiIndex].sources);
      if (bubble) bubble.innerHTML = K.md(answer || '（没有生成内容）');
      scrollChatToEnd();
    } catch (err) {
      var message = (err && err.name === 'AbortError')
        ? '已停止生成。'
        : (err.message || 'AI 回答失败，请稍后重试');
      S.chat[aiIndex] = { role: 'ai', content: answer ? answer + '\n\n（生成中断）' : message, sources: [] };
      if (bubble) bubble.innerHTML = K.md(S.chat[aiIndex].content);
      if (!answer) K.toast(message, 'err');
    } finally {
      finishAsk();
    }

    function finishAsk() {
      S.streaming = null;
      var sendArea = qs('.ask-box');
      if (sendArea) {
        var btn = sendArea.querySelector('.send');
        if (btn) {
          btn.setAttribute('data-act', 'send');
          btn.setAttribute('aria-label', '发送');
          btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M12 5.5 18.5 12 12 18.5"/></svg>';
        }
      }
      var chat = $('chat');
      if (chat) chat.innerHTML = S.chat.map(renderMessage).join('');
      scrollChatToEnd();
    }
  }

  /* =========================================================
     阶段洞察
     ========================================================= */

  async function loadInsights() {
    setSyncBusy(true);
    try {
      S.insights = await K.db.listInsights(20);
      renderInsights();
    } catch (err) {
      K.toast(err.message || '洞察加载失败', 'err');
    } finally {
      setSyncBusy(false);
    }
  }

  function periodLabel(key) {
    if (key === '30d') return '近 30 天';
    if (key === 'all') return '全部记录';
    return '近 7 天';
  }

  function periodStart(key) {
    if (key === 'all') return 0;
    var days = key === '30d' ? 30 : 7;
    return Date.now() - days * 86400000;
  }

  function renderInsights() {
    var view = $('view');
    if (!view) return;

    view.innerHTML = '' +
      '<div class="view-inner">' +
        '<header class="page-head">' +
          '<h2>阶段洞察</h2>' +
          '<p>把一段时间的记录压缩成一份复盘，并给出下一步的行动建议。</p>' +
        '</header>' +

        '<div class="gen-card">' +
          '<div class="gen-row">' +
            '<div class="grow">' +
              '<h3>生成阶段总结</h3>' +
              '<p>选择时间范围，AI 会归纳主题、进展与建议。</p>' +
            '</div>' +
            '<div class="filters" style="margin:0">' +
              ['7d', '30d', 'all'].map(function (p) {
                return '<button class="chip' + (S.period === p ? ' is-active' : '') +
                  '" data-act="period" data-period="' + p + '">' + periodLabel(p) + '</button>';
              }).join('') +
            '</div>' +
            '<button class="btn primary" data-act="gen-insight" type="button">生成总结</button>' +
          '</div>' +
          '<div id="genStatus"></div>' +
        '</div>' +

        '<div id="insightList">' +
          (S.insights.length
            ? S.insights.map(insightCard).join('')
            : emptyState('还没有阶段总结',
                '积攒一些记录后，在这里生成第一份复盘，看看这段时间到底在忙什么。')) +
        '</div>' +
      '</div>';
  }

  function insightCard(item) {
    return '' +
      '<article class="insight-card">' +
        '<div class="insight-head">' +
          '<div>' +
            '<h3>' + K.esc(item.title) + '</h3>' +
            '<span class="when">' + K.esc(periodLabel(item.period)) + ' · ' +
              item.note_count + ' 条记录 · ' + K.fmtDateTime(item.created_at) + '</span>' +
          '</div>' +
          '<div class="acts">' +
            '<button class="btn tiny ghost danger" data-act="del-insight" data-id="' + item.id + '">删除</button>' +
          '</div>' +
        '</div>' +
        '<p class="insight-summary">' + K.esc(item.summary) + '</p>' +
        '<div class="insight-cols">' +
          '<div class="insight-col">' +
            '<h5>关键进展</h5>' +
            (item.highlights.length
              ? '<ul>' + item.highlights.map(function (h) { return '<li>' + K.esc(h) + '</li>'; }).join('') + '</ul>'
              : '<p class="insight-summary" style="margin:0">暂无</p>') +
          '</div>' +
          '<div class="insight-col actions">' +
            '<h5>行动建议</h5>' +
            (item.actions.length
              ? '<ul>' + item.actions.map(function (a) { return '<li>' + K.esc(a) + '</li>'; }).join('') + '</ul>'
              : '<p class="insight-summary" style="margin:0">暂无</p>') +
          '</div>' +
        '</div>' +
      '</article>';
  }

  async function generateInsight() {
    var btn = qs('[data-act="gen-insight"]');
    var host = $('genStatus');
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    if (host) {
      host.innerHTML = '<div class="ask-hint" style="margin-top:12px">' +
        '正在阅读这段时间的记录 <span class="typing"><span></span><span></span><span></span></span></div>';
    }

    try {
      var all = await K.db.listNotes({ limit: 200 });
      var from = periodStart(S.period);
      var scoped = S.period === 'all'
        ? all
        : all.filter(function (n) {
            var d = K.toDate(n.created_at);
            return d && d.getTime() >= from;
          });

      if (!scoped.length) {
        if (host) host.innerHTML = '';
        K.toast('这个时间范围内还没有记录');
        return;
      }

      var result = await K.ai.periodReview(scoped, periodLabel(S.period));
      var saved = await K.db.createInsight({
        period: S.period,
        title: result.title,
        summary: result.summary,
        highlights: result.highlights,
        actions: result.actions,
        note_count: scoped.length
      });

      S.insights.unshift({
        id: Number(saved.id),
        period: S.period,
        title: result.title,
        summary: result.summary,
        highlights: result.highlights,
        actions: result.actions,
        note_count: scoped.length,
        created_at: saved.created_at || new Date().toISOString()
      });

      if (host) host.innerHTML = '';
      renderInsights();
      K.toast('阶段总结已生成', 'ok');
    } catch (err) {
      if (host) host.innerHTML = '';
      K.toast(err.message || '生成失败', 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '生成总结'; }
    }
  }

  async function deleteInsight(id) {
    if (!window.confirm('删除这份阶段总结？此操作不可恢复。')) return;
    try {
      await K.db.deleteInsight(id);
      S.insights = S.insights.filter(function (i) { return i.id !== id; });
      renderInsights();
      K.toast('已删除', 'ok');
    } catch (err) {
      K.toast(err.message || '删除失败', 'err');
    }
  }

  /* =========================================================
     详情抽屉
     ========================================================= */

  function bindDrawerEvents() {
    var drawer = $('drawer');
    if (!drawer) return;
    drawer.addEventListener('click', function (e) {
      var close = e.target.closest('[data-close]');
      if (close) { closeDrawer(); return; }
      var target = e.target.closest('[data-act]');
      if (!target) return;
      onDrawerAction(target.getAttribute('data-act'), target);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('drawer').classList.contains('hidden')) closeDrawer();
    });
  }

  function closeDrawer() {
    $('drawer').classList.add('hidden');
    $('drawer').setAttribute('aria-hidden', 'true');
    S.drawer = null;
  }

  async function openNote(id) {
    var cached = S.notes.concat(S.todos).filter(function (n) { return n.id === id; })[0];
    try {
      var note = cached || await K.db.getNote(id);
      if (!note) { K.toast('这条记录不见了'); return; }
      S.drawer = note;
      renderDrawer(note);
      $('drawer').classList.remove('hidden');
      $('drawer').setAttribute('aria-hidden', 'false');
    } catch (err) {
      K.toast(err.message || '打开失败', 'err');
    }
  }

  function renderDrawer(note, reasons) {
    var kind = K.kindOf(note.kind);
    var due = K.fmtDue(note.due_at);
    var points = note.key_points || [];
    var tags = note.tags || [];
    var related = note.related_ids || [];

    var panel = $('drawerPanel');
    panel.innerHTML = '' +
      '<div class="drawer-head">' +
        '<span class="pill ' + kind.cls + '">' + kind.label + '</span>' +
        (note.category ? '<span class="pill cat">' + K.esc(note.category) + '</span>' : '') +
        (note.ai_state === 'failed' ? '<span class="pill danger">待重新整理</span>' : '') +
        '<button class="icon-btn close-btn" data-act="close" aria-label="关闭">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="drawer-body">' +
        '<input class="d-title" id="dTitle" value="' + K.esc(note.title || '') + '" placeholder="给它一个标题" />' +
        '<textarea class="d-content" id="dContent" placeholder="内容">' + K.esc(note.content) + '</textarea>' +
        '<div class="d-meta">' +
          '<span class="note-time">记录于 ' + K.fmtDateTime(note.created_at) + '</span>' +
          (note.kind === 'todo'
            ? '<span class="pill ' + (note.status === 'done' ? 'done' : '') + '">' +
                (note.status === 'done' ? '已完成' : '待处理') + '</span>'
            : '') +
          (due.text ? '<span class="pill ' + (due.overdue ? 'danger' : '') + '">' + due.text + '</span>' : '') +
        '</div>' +

        '<section class="d-section">' +
          '<div class="d-section-head"><h4>AI 摘要</h4><span class="line"></span></div>' +
          (note.summary
            ? '<div class="ai-block">' + K.esc(note.summary) + '</div>'
            : '<div class="ai-block" style="color:#7c857f">还没有摘要，点下方「重新分析」让 AI 读一遍。</div>') +
        '</section>' +

        '<section class="d-section">' +
          '<div class="d-section-head"><h4>重点信息</h4><span class="line"></span></div>' +
          (points.length
            ? '<ul class="kp-list">' + points.map(function (p, i) {
                return '<li><span class="idx">' + (i + 1) + '</span><span>' + K.esc(p) + '</span></li>';
              }).join('') + '</ul>'
            : '<div class="ai-block" style="color:#7c857f">暂无要点。</div>') +
        '</section>' +

        (tags.length
          ? '<section class="d-section">' +
              '<div class="d-section-head"><h4>标签</h4><span class="line"></span></div>' +
              '<div class="note-tags">' + tags.map(function (t) {
                return '<span class="tag">#' + K.esc(t) + '</span>';
              }).join('') + '</div>' +
            '</section>'
          : '') +

        '<section class="d-section">' +
          '<div class="d-section-head"><h4>相关内容</h4><span class="line"></span></div>' +
          '<div class="rel-list" id="relList">' +
            (related.length ? '<div class="ask-hint">正在加载关联记录…</div>'
              : '<div class="ai-block" style="color:#7c857f">这条记录还没有关联到其它内容。</div>') +
          '</div>' +
        '</section>' +
      '</div>' +
      '<div class="drawer-foot">' +
        '<button class="btn primary" data-act="save" type="button">保存修改</button>' +
        '<button class="btn" data-act="reanalyze" type="button">重新分析</button>' +
        '<button class="btn" data-act="points" type="button">提取重点</button>' +
        (note.kind !== 'todo'
          ? '<button class="btn" data-act="toTodo" type="button">转为待办</button>'
          : '') +
        '<button class="btn danger" data-act="delete" type="button" style="margin-left:auto">删除</button>' +
      '</div>';

    if (related.length) loadRelated(related, reasons);
  }

  async function loadRelated(ids, reasons) {
    var host = $('relList');
    if (!host) return;
    try {
      var rows = await K.db.getByIds(ids);
      var reasonMap = {};
      (reasons || []).forEach(function (r) { reasonMap[r.id] = r.reason; });
      if (!rows.length) {
        host.innerHTML = '<div class="ai-block" style="color:#7c857f">关联的记录已被删除。</div>';
        return;
      }
      host.innerHTML = rows.map(function (r) {
        var k = K.kindOf(r.kind);
        return '<button class="rel-item" data-act="open-rel" data-id="' + r.id + '">' +
          '<div style="flex:1;min-width:0">' +
            '<p class="rt">' + K.esc(r.title || K.truncate(r.content, 20)) + '</p>' +
            '<p class="rs">' + K.esc(reasonMap[r.id] || (r.summary || K.truncate(r.content, 40))) + '</p>' +
          '</div>' +
          '<span class="pill ' + k.cls + '">' + k.label + '</span>' +
        '</button>';
      }).join('');
    } catch (err) {
      host.innerHTML = '<div class="ai-block" style="color:#c1445a">关联记录加载失败</div>';
    }
  }

  async function onDrawerAction(act, el) {
    var note = S.drawer;
    if (!note) return;

    if (act === 'close') { closeDrawer(); return; }

    if (act === 'open-rel') {
      openNote(Number(el.getAttribute('data-id')));
      return;
    }

    if (act === 'save') {
      var title = ($('dTitle').value || '').trim();
      var content = ($('dContent').value || '').trim();
      if (!content) { K.toast('内容不能为空'); return; }
      el.disabled = true;
      try {
        var updated = await K.db.updateNote(note.id, {
          title: title || K.truncate(content, 24),
          content: content,
          ai_state: 'pending'
        });
        S.drawer = updated;
        updateLocal(updated.id, updated);
        K.toast('已保存，正在重新整理…', 'ok');
        render();
        await enrich(updated);
      } catch (err) {
        K.toast(err.message || '保存失败', 'err');
      } finally {
        el.disabled = false;
      }
      return;
    }

    if (act === 'reanalyze') {
      el.disabled = true;
      try {
        await enrich(note);
        K.toast('已重新整理', 'ok');
      } finally {
        el.disabled = false;
      }
      return;
    }

    if (act === 'points') {
      el.disabled = true;
      el.textContent = '提取中…';
      try {
        var points = await K.ai.extractPoints(note);
        var updated2 = await K.db.updateNote(note.id, { key_points: points });
        S.drawer = updated2;
        updateLocal(updated2.id, updated2);
        renderDrawer(updated2);
        K.toast('重点已更新', 'ok');
      } catch (err) {
        K.toast(err.message || '提取失败', 'err');
        el.disabled = false;
        el.textContent = '提取重点';
      }
      return;
    }

    if (act === 'toTodo') {
      el.disabled = true;
      try {
        var todo = await K.db.updateNote(note.id, {
          kind: 'todo',
          status: 'inbox',
          priority: note.priority || 'medium'
        });
        S.drawer = todo;
        updateLocal(todo.id, todo);
        renderDrawer(todo);
        render();
        K.toast('已转为待办', 'ok');
      } catch (err) {
        K.toast(err.message || '转换失败', 'err');
      } finally {
        el.disabled = false;
      }
      return;
    }

    if (act === 'delete') {
      if (!window.confirm('删除这条记录？此操作不可恢复。')) return;
      el.disabled = true;
      try {
        await K.db.deleteNote(note.id);
        S.notes = S.notes.filter(function (n) { return n.id !== note.id; });
        S.todos = S.todos.filter(function (n) { return n.id !== note.id; });
        closeDrawer();
        render();
        updateTodoBadge();
        K.toast('已删除', 'ok');
      } catch (err) {
        K.toast(err.message || '删除失败', 'err');
        el.disabled = false;
      }
    }
  }

  /* =========================================================
     事件分发
     ========================================================= */

  function onViewClick(e) {
    var target = e.target.closest('[data-act]');
    if (!target) return;
    var act = target.getAttribute('data-act');

    if (act === 'capture') { e.preventDefault(); capture(); return; }

    if (act === 'filter') {
      S.filter = target.getAttribute('data-kind');
      renderInbox();
      refreshInbox();
      return;
    }

    if (act === 'open') {
      // 点复选框时不触发打开
      if (e.target.closest('[data-act="toggle"]')) return;
      openNote(Number(target.getAttribute('data-id')));
      return;
    }

    if (act === 'toggle') {
      e.stopPropagation();
      toggleTodo(Number(target.getAttribute('data-id')));
      return;
    }

    if (act === 'organize') { organizeTodos(); return; }

    if (act === 'suggest') {
      sendQuestion(target.getAttribute('data-q'));
      return;
    }

    if (act === 'send') {
      var input = $('askInput');
      sendQuestion(input ? input.value : '');
      return;
    }

    if (act === 'stop') {
      if (S.streaming) S.streaming.abort();
      return;
    }

    if (act === 'period') {
      S.period = target.getAttribute('data-period');
      renderInsights();
      return;
    }

    if (act === 'gen-insight') { generateInsight(); return; }

    if (act === 'del-insight') {
      deleteInsight(Number(target.getAttribute('data-id')));
    }
  }

  function onViewKeydown(e) {
    if (e.target && e.target.id === 'capture') {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        capture();
      }
    }
    if (e.target && e.target.id === 'askInput') {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendQuestion(e.target.value);
      }
    }
  }

  /* =========================================================
     对外接口：供桌面小机器人联动读取
     ========================================================= */

  K.app = {
    /** 给桌宠用的状态快照（数字都很小，一次心跳推一次不成负担） */
    snapshot: function () {
      var b = todoBuckets();
      var open = b.overdue.length + b.today.length + b.upcoming.length + b.someday.length;
      var soon = b.overdue.concat(b.today).slice(0, 3);
      return {
        todos: open,
        overdue: b.overdue.length,
        today: b.today.length,
        upcoming: b.upcoming.length,
        notes: S.notes.length,
        pendingAi: S.notes.filter(function (n) { return n.ai_state === 'pending'; }).length,
        next: soon.map(function (t) {
          return { title: t.title || K.truncate(t.content, 24), due: t.due_at || null };
        }),
        ts: Date.now()
      };
    },

    /** 桌宠点了「记一条」：切回收件箱并把光标放进输入框 */
    focusComposer: function (mode) {
      if (S.view !== 'inbox') switchView('inbox', true);
      setTimeout(function () {
        var c = $('capture');
        if (c) {
          try { c.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* 忽略 */ }
          c.focus();
        }
        K.toast(mode === 'note' ? '小机器人把你带过来了，写吧' : '已回到收件箱');
      }, 80);
    },

    /** 桌宠点了状态牌：跳到待办清单 */
    showTodo: function () {
      if (S.view !== 'todo') switchView('todo', true);
      K.toast('这是目前要处理的事');
    },

    /** 桌宠点了机箱：直接进问答 */
    ask: function () {
      if (S.view !== 'ask') switchView('ask', true);
      setTimeout(function () {
        var el = $('askInput');
        if (el) { try { el.focus(); } catch (e) { /* 忽略 */ } }
        K.toast('问吧，我翻你自己的记录来答');
      }, 80);
    },

    /** 桌面随手记（Ctrl+Alt+Space / 剪贴板快收）经本地桥送进来的一条 */
    ingestOne: async function (text) {
      var body = String(text || '').trim();
      if (!body) throw new Error('内容为空');
      var note = await K.db.createNote({ content: body });
      S.notes.unshift(note);
      if (S.view === 'inbox') render();
      petSync(true);
      K.toast('桌面记下的一条已进收件箱', 'ok');
      enrich(note);                 // 后台归类，完成后桌宠会播报归到哪一类
      return note;
    }
  };

  /* =========================================================
     启动
     ========================================================= */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
