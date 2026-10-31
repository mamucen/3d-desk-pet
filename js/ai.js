/**
 * 大模型能力层：分类、摘要、要点、关联、问答、阶段复盘、待办整理。
 * 所有调用都走 cloud.llm.chat.completions.create({ stream: true, ... })，
 * 并保证 messages[0] 是应用自己的 system 消息。
 */
(function () {
  'use strict';

  var K = window.Keeper;

  var modelCache = { id: null, pending: null };

  /* ---------------- 模型 ---------------- */

  async function resolveModel() {
    if (modelCache.id) return modelCache.id;
    if (modelCache.pending) return modelCache.pending;

    modelCache.pending = (async function () {
      var raw = await window.cloud.llm.models.list();
      var list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
      var usable = list.filter(function (m) { return m && m.disabled !== true && m.id; });
      if (!usable.length) return null;
      modelCache.id = usable[0].id;
      return modelCache.id;
    })();

    try {
      return await modelCache.pending;
    } finally {
      modelCache.pending = null;
    }
  }

  /* ---------------- 错误 ---------------- */

  function friendly(error) {
    if (!error) return new Error('AI 暂时不可用，请稍后再试');
    var errObj = error.error || {};
    var code = String(errObj.code || '');
    var detail = errObj.message || error.message || '';

    if (/^quota_/.test(code)) {
      if (code === 'quota_rate_limited' && error.retryAfterMs) {
        return new Error('AI 调用太频繁了，请 ' + Math.ceil(error.retryAfterMs / 1000) + ' 秒后再试');
      }
      return new Error('今日 AI 额度已用完，请稍后再试或联系管理员扩容');
    }
    if (/^auth_/.test(code)) return new Error('AI 服务鉴权失败，请刷新页面后重试');
    if (/^request_/.test(code)) return new Error('AI 请求参数有误：' + (detail || code));
    if (/^gateway_/.test(code) || /^model_/.test(code)) return new Error('模型服务暂时不可用，请稍后重试');
    if (/network|failed to fetch|timeout/i.test(detail)) return new Error('网络不稳定，AI 请求未完成');
    return new Error(detail || 'AI 处理失败，请稍后重试');
  }

  /* ---------------- 基础调用 ---------------- */

  async function chat(options) {
    var modelId = await resolveModel();
    if (!modelId) throw new Error('当前应用暂无可用的 AI 模型，请联系管理员');

    var params = {
      model: modelId,
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.userContent || options.user }
      ],
      stream: true,
      temperature: typeof options.temperature === 'number' ? options.temperature : 0.4
    };
    if (options.json) params.response_format = { type: 'json_object' };
    if (options.signal) params.signal = options.signal;

    var text = '';
    try {
      for await (var chunk of window.cloud.llm.chat.completions.create(params)) {
        var delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (delta && delta.content) {
          text += delta.content;
          if (options.onDelta) options.onDelta(delta.content);
        }
      }
    } catch (err) {
      throw friendly(err);
    }
    return text;
  }

  async function chatJson(system, user) {
    var text = await chat({ system: system, user: user, json: true, temperature: 0.2 });
    var parsed = K.parseJson(text);
    if (!parsed) throw new Error('AI 返回的内容无法解析，请重试');
    return parsed;
  }

  /* ---------------- 提示词 ---------------- */

  var ANALYZE_SYSTEM = [
    '你是「信息管家」的内容整理引擎。输入是用户随手记下的一条内容，以及若干条已有记录（用于判断关联）。',
    '只输出一个 JSON 对象，不要输出任何解释文字或代码块标记。字段如下：',
    '{',
    '  "title": "不超过 18 个字的中文标题，能概括这条内容",',
    '  "kind": "thought 或 resource 或 todo",',
    '  "category": "2-6 字的领域分类，如 产品设计 / 技术 / 读书 / 生活 / 工作 / 灵感 / 健康 / 财务",',
    '  "summary": "不超过 60 字的一句话摘要",',
    '  "key_points": ["2-4 条要点，每条不超过 30 字"],',
    '  "tags": ["2-4 个标签，不带 # 号"],',
    '  "priority": "high 或 medium 或 low，非待办填 null",',
    '  "due_hint": "内容中出现明确时间要求时输出 YYYY-MM-DD，否则 null",',
    '  "related": [{"id": 12, "reason": "不超过 15 字的关联理由"}]',
    '}',
    '判定规则：',
    '1. kind：含有明确“要做的事 / 要跟进的事”用 todo；是外部资料、链接、摘抄、他人观点用 resource；其余为 thought。',
    '2. related 只能从给定候选记录的 id 中选，最多 3 条，没有真正相关的就给空数组，不要硬凑。',
    '3. 全部使用简体中文，不要编造内容里没有的信息。'
  ].join('\n');

  var QA_SYSTEM = [
    '你是「信息管家」，一个基于用户个人记录回答问题的助理。',
    '规则：',
    '1. 只依据【资料】中的内容回答，不要编造资料里没有的事实。',
    '2. 引用资料时用 [1] [2] 这样的编号标注来源。',
    '3. 如果资料不足以回答，先明确说“你的记录里还没有直接相关的信息”，再给出可以补充记录的方向。',
    '4. 使用简体中文，语气自然、简洁，必要时用短列表，不要长篇大论。',
    '5. 不要输出 Markdown 表格，不要输出代码块。'
  ].join('\n');

  var REVIEW_SYSTEM = [
    '你是「信息管家」的阶段复盘助手。输入是用户在一段时间内的全部记录（含想法、资料、待办）。',
    '只输出一个 JSON 对象，不要输出解释文字：',
    '{',
    '  "title": "不超过 20 字的阶段主题标题",',
    '  "summary": "150-250 字的阶段总结，说明这段时间关注什么、进展如何、有什么模式",',
    '  "highlights": ["3-5 条关键进展或反复出现的主题，每条不超过 30 字"],',
    '  "actions": ["3-5 条具体可执行的后续行动建议，每条不超过 35 字，动词开头"]',
    '}',
    '要求：结论要基于记录事实，不要空泛；如果记录很少，就如实说明并给出“先多记录”的建议。'
  ].join('\n');

  var TODO_SYSTEM = [
    '你是任务整理助手。输入是用户的待办清单（可能有重复、含糊或过期的项）。',
    '只输出一个 JSON 对象，不要输出解释文字：',
    '{',
    '  "overview": "一句话整体判断，不超过 40 字",',
    '  "groups": [{"name": "分组名，2-6 字", "items": ["整合后的任务描述，不超过 25 字"]}],',
    '  "next_actions": ["2-4 条今天最该推进的事，动词开头"],',
    '  "risks": ["1-3 条拖延或风险提示"]',
    '}',
    '要求：合并语义重复的任务，把含糊的待办改写得更具体，最多分 4 组。'
  ].join('\n');

  var POINTS_SYSTEM = [
    '你是信息提取助手。从用户给出的一段内容中提炼真正有价值的信息。',
    '只输出一个 JSON 对象：{"key_points": ["3-5 条要点，每条不超过 30 字"]}',
    '要点要具体、可复用，不要复述原文的修辞。'
  ].join('\n');

  var WATCH_SYSTEM = [
    '你是「信息管家」的桌面小机器人，刚刚陪着用户看完了一段 B 站视频。',
    '输入可能包含三部分：视频标题；从 B 站抓到的事实（UP 主、时长、简介、弹幕抽样、有时还有字幕）；从视频里截取的画面帧。',
    '只输出一个 JSON 对象，不要解释文字：',
    '{',
    '  "verdict": "一句有态度的话，30-60 字，说清值不值得看、为什么",',
    '  "points": ["3-5 条内容要点，每条不超过 30 字"],',
    '  "highlights": ["1-3 条值得看的地方"],',
    '  "flaws": ["1-3 条可以跳过或不足的地方"],',
    '  "rating": 8.4,',
    '  "tags": ["2-4 个标签，不带 # 号"],',
    '  "audience": "适合谁看，30-60 字"',
    '}',
    '要求：',
    '1. 有 B 站资料（简介/弹幕/字幕）时，内容要点必须基于这些真实信息，别只描述画面。',
    '2. 弹幕是观众的真实反应，可以用来判断哪里高能、哪里劝退，但别把弹幕当成视频里说的话。',
    '3. 画面帧用来补充风格、演示方式、观感这类信息；看不清就如实说“从画面看…”，不要编造。',
    '4. 全部使用简体中文，不要输出代码块。'
  ].join('\n');

  /* ---------------- 具体能力 ---------------- */

  function candidateLine(note) {
    var kind = K.kindOf(note.kind).label;
    return '#' + note.id + ' [' + kind + (note.category ? '/' + note.category : '') + '] ' +
      (note.title || K.truncate(note.content, 20)) +
      (note.summary ? '｜' + K.truncate(note.summary, 40) : '');
  }

  function normalizeKind(kind) {
    var k = String(kind || '').toLowerCase();
    if (k === 'todo' || k === 'task') return 'todo';
    if (k === 'resource' || k === 'material' || k === 'link') return 'resource';
    return 'thought';
  }

  function normalizePriority(value, kind) {
    if (kind !== 'todo') return '';
    var p = String(value || '').toLowerCase();
    if (p === 'high' || p === 'medium' || p === 'low') return p;
    return 'medium';
  }

  function toDueIso(hint) {
    if (!hint) return null;
    var m = String(hint).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0, 0);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  var ai = {
    available: function () {
      return !!(window.cloud && window.cloud.llm);
    },

    /** 分析一条新记录：分类 / 摘要 / 要点 / 标签 / 优先级 / 关联 */
    analyzeNote: async function (note, candidates) {
      var user = JSON.stringify({
        content: note.content,
        candidates: (candidates || []).map(function (c) {
          return {
            id: c.id,
            title: c.title || K.truncate(c.content, 20),
            summary: K.truncate(c.summary || '', 50),
            kind: c.kind,
            category: c.category || '',
            tags: c.tags || []
          };
        })
      });

      var result = await chatJson(ANALYZE_SYSTEM, user);

      var validIds = (candidates || []).map(function (c) { return c.id; });
      var related = Array.isArray(result.related) ? result.related : [];
      var relatedIds = related
        .map(function (r) { return Number(r && r.id); })
        .filter(function (id, idx, arr) {
          return validIds.indexOf(id) >= 0 && id !== note.id && arr.indexOf(id) === idx;
        })
        .slice(0, 3);

      var kind = normalizeKind(result.kind);

      return {
        title: K.truncate(result.title || note.content, 24) || '未命名记录',
        kind: kind,
        category: K.truncate(result.category || '未分类', 12),
        summary: K.truncate(result.summary || '', 120),
        key_points: K.toArray(result.key_points).slice(0, 5),
        tags: K.toArray(result.tags).map(function (t) { return t.replace(/^#/, ''); }).slice(0, 8),
        priority: normalizePriority(result.priority, kind),
        due_at: kind === 'todo' ? toDueIso(result.due_hint) : null,
        related_ids: relatedIds,
        related_reasons: related
          .filter(function (r) { return relatedIds.indexOf(Number(r && r.id)) >= 0; })
          .map(function (r) { return { id: Number(r.id), reason: K.truncate(r.reason || '', 20) }; })
      };
    },

    /** 重新提取重点 */
    extractPoints: async function (note) {
      var result = await chatJson(POINTS_SYSTEM, JSON.stringify({
        title: note.title,
        content: note.content
      }));
      return K.toArray(result.key_points).slice(0, 6);
    },

    /** 流式问答 */
    answer: async function (question, notes, options) {
      var opts = options || {};
      var lines = notes.map(function (n, i) {
        var meta = [
          K.fmtDate(n.created_at),
          K.kindOf(n.kind).label,
          n.category || '未分类'
        ].join(' · ');
        var body = [
          n.title || K.truncate(n.content, 24),
          n.summary ? '摘要：' + n.summary : '',
          (n.key_points && n.key_points.length) ? '要点：' + n.key_points.join('；') : '',
          '原文：' + K.truncate(n.content, 220)
        ].filter(Boolean).join('\n');
        return '[' + (i + 1) + '] （' + meta + '）\n' + body;
      });

      var user = '【资料】\n' + (lines.length ? lines.join('\n\n') : '（暂无记录）') +
        '\n\n【问题】\n' + question;

      return chat({
        system: QA_SYSTEM,
        user: user,
        temperature: 0.3,
        onDelta: opts.onDelta,
        signal: opts.signal
      });
    },

    /** 阶段复盘 */
    periodReview: async function (notes, periodLabel) {
      var lines = notes.slice(0, 90).map(function (n) {
        return '- ' + K.fmtDate(n.created_at) + '｜' + K.kindOf(n.kind).label +
          (n.category ? '/' + n.category : '') +
          (n.status === 'done' ? '（已完成）' : '') +
          '｜' + (n.title || K.truncate(n.content, 20)) +
          (n.summary ? '：' + K.truncate(n.summary, 60) : '');
      });
      var user = '时间范围：' + periodLabel + '，共 ' + notes.length + ' 条记录。\n\n' +
        (lines.length ? lines.join('\n') : '（这段时间没有记录）');
      var result = await chatJson(REVIEW_SYSTEM, user);
      return {
        title: K.truncate(result.title || periodLabel + '复盘', 24),
        summary: String(result.summary || '').trim(),
        highlights: K.toArray(result.highlights).slice(0, 6),
        actions: K.toArray(result.actions).slice(0, 6)
      };
    },

    /** 待办整理 */
    organizeTodos: async function (todos) {      var lines = todos.map(function (t, i) {
        var due = K.fmtDue(t.due_at);
        return (i + 1) + '. ' + (t.title || K.truncate(t.content, 24)) +
          '｜优先级 ' + ((K.PRIORITY[t.priority] || {}).label || '未定') +
          (due.text ? '｜' + due.text : '');
      });
      var user = '待办清单：\n' + lines.join('\n');
      var result = await chatJson(TODO_SYSTEM, user);
      return {
        overview: String(result.overview || '').trim(),
        groups: (Array.isArray(result.groups) ? result.groups : []).map(function (g) {
          return { name: K.truncate(g.name || '其他', 12), items: K.toArray(g.items).slice(0, 8) };
        }).filter(function (g) { return g.items.length; }),
        next_actions: K.toArray(result.next_actions).slice(0, 5),
        risks: K.toArray(result.risks).slice(0, 4)
      };
    },

    /** 陪看分析：把一组视频截图交给多模态模型；模型看不了图就退回纯标题 */
    analyzeVideo: async function (payload) {
      var p = payload || {};
      var title = String(p.title || 'B 站视频');
      var frames = (Array.isArray(p.frames) ? p.frames : []).filter(function (f) { return f && typeof f.data === 'string' && f.data; }).slice(0, 16);
      // 桌宠从 B 站接口抓来的真实资料：有它就以文字为主，画面只作补充
      var biliText = String(p.bili || '').slice(0, 6000);
      var hasBili = !!biliText;

      function toResult(raw) {
        return {
          verdict: K.truncate(raw.verdict || '看完了，这条值得记一笔。', 140),
          points: K.toArray(raw.points).slice(0, 6),
          highlights: K.toArray(raw.highlights).slice(0, 4),
          flaws: K.toArray(raw.flaws).slice(0, 4),
          tags: K.toArray(raw.tags).map(function (t) { return String(t).replace(/^#/, ''); }).slice(0, 8),
          audience: K.truncate(raw.audience || '', 140),
          rating: (function () {
            var n = Number(raw.rating);
            if (!isFinite(n)) return 0;
            return Math.max(0, Math.min(10, n));
          })(),
          vision: !!raw.__vision
        };
      }

      if (frames.length || hasBili) {
        var head = hasBili
          ? ('视频标题：' + title + '\n\n' + biliText +
             '\n\n下面还有 ' + frames.length + ' 张按时间顺序截的画面，用来补充风格和观感。')
          : ('视频标题：' + title + '\n下面按时间顺序给出 ' + frames.length +
             ' 张画面截图，请看完后按约定格式给出你的观点。');
        var content = [{ type: 'text', text: head }];
        frames.forEach(function (f, i) {
          content.push({ type: 'text', text: '第 ' + (i + 1) + ' / ' + frames.length + ' 帧：' });
          content.push({ type: 'image_url', image_url: { url: f.data } });
        });

        var text = '';
        try {
          text = await chat({ system: WATCH_SYSTEM, userContent: content, json: true, temperature: 0.35 });
          var parsed = K.parseJson(text);
          if (parsed) {
            parsed.__vision = true;
            return toResult(parsed);
          }
        } catch (err) {
          // 多半是模型不吃图，落到下面的降级路径
        }
      }

      // 降级一：只有图不行，但 B 站资料是纯文本，值得再试一次
      if (hasBili) {
        try {
          var onlyText = await chat({
            system: WATCH_SYSTEM + '\n（注意：这次没有画面帧，只有 B 站资料，请不要假装看到了画面。）',
            userContent: [{ type: 'text', text: '视频标题：' + title + '\n\n' + biliText }],
            json: true,
            temperature: 0.35
          });
          var p2 = K.parseJson(onlyText);
          if (p2) { p2.__vision = false; return toResult(p2); }
        } catch (err2) { /* 继续往下 */ }
      }

      var fallback = await chatJson(WATCH_SYSTEM + '\n（注意：这次只有标题，没有画面帧，请明确说明这一点。）',
        '视频标题：' + title + '\n（画面帧不可用，请基于标题谨慎判断，并承认信息有限）');
      return toResult(fallback);
    },

    candidateLine: candidateLine
  };

  K.ai = ai;
})();
