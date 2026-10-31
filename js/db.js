/**
 * 数据访问层：所有读写都通过云数据库（PostgREST 风格 API）。
 * owner_id 由数据库 DEFAULT auth.uid() 填充，前端永不发送；
 * 访问边界由 RLS 承担，前端不做“这条是不是我的”判断。
 */
(function () {
  'use strict';

  var K = window.Keeper;

  function db() {
    if (!window.cloud || !window.cloud.database) {
      throw new Error('云服务尚未就绪，请刷新页面重试');
    }
    return window.cloud.database;
  }

  function friendly(error) {
    if (!error) return new Error('请求失败，请稍后重试');
    var code = error.code;
    if (code === '42P01') return new Error('数据表尚未就绪，请稍后重试');
    if (code === '42501') return new Error('你没有权限操作这条记录');
    if (code === '23505') return new Error('这条内容已经存在了');
    if (code === 'PGRST116') return new Error('记录不存在或不属于你');
    var msg = error.message || '请求失败，请稍后重试';
    if (/jwt|token|unauthor|not signed/i.test(msg)) {
      return new Error('登录状态已失效，请重新登录');
    }
    return new Error(msg);
  }

  /** 统一解包 { data, error } 信封 */
  async function run(builder) {
    var res = await builder;
    if (res && res.error) throw friendly(res.error);
    return res ? res.data : null;
  }

  /** 清理关键词，避免破坏 PostgREST 的 or 过滤语法与 LIKE 通配 */
  function sanitizeKeyword(keyword) {
    return String(keyword || '')
      .replace(/[,()*%\\:"'`]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
  }

  function normalize(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      title: row.title || '',
      content: row.content || '',
      kind: row.kind || 'thought',
      category: row.category || '',
      summary: row.summary || '',
      key_points: Array.isArray(row.key_points) ? row.key_points : [],
      tags: Array.isArray(row.tags) ? row.tags : [],
      priority: row.priority || '',
      due_at: row.due_at || null,
      status: row.status || 'inbox',
      related_ids: Array.isArray(row.related_ids)
        ? row.related_ids.map(Number).filter(function (n) { return !isNaN(n); })
        : [],
      ai_state: row.ai_state || 'pending',
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  var dbApi = {
    /* ---------------- 条目 ---------------- */

    listNotes: async function (options) {
      var opts = options || {};
      var query = db().from('notes').select('*')
        .order('created_at', { ascending: false })
        .limit(opts.limit || 120);

      if (opts.kind && opts.kind !== 'all') query = query.eq('kind', opts.kind);
      if (opts.statuses && opts.statuses.length) query = query.in('status', opts.statuses);
      if (opts.keyword) {
        var k = sanitizeKeyword(opts.keyword);
        if (k) {
          query = query.or(
            'title.ilike.%' + k + '%,content.ilike.%' + k + '%,summary.ilike.%' + k + '%'
          );
        }
      }

      var rows = await run(query);
      return (rows || []).map(normalize);
    },

    getNote: async function (id) {
      var rows = await run(db().from('notes').select('*').eq('id', id).limit(1));
      return rows && rows.length ? normalize(rows[0]) : null;
    },

    createNote: async function (payload) {
      var rows = await run(db().from('notes').insert({
        content: String(payload.content || '').trim(),
        title: payload.title || '',
        kind: payload.kind || 'thought',
        status: 'inbox',
        ai_state: 'pending'
      }).select());
      if (!rows || !rows.length) throw new Error('保存失败，请重试');
      return normalize(rows[0]);
    },

    updateNote: async function (id, patch) {
      var payload = Object.assign({}, patch, { updated_at: new Date().toISOString() });
      var rows = await run(db().from('notes').update(payload).eq('id', id).select());
      // RLS 过滤后返回空数组 —— 不是成功
      if (!rows || !rows.length) throw new Error('这条记录不存在，或者不属于当前账号');
      return normalize(rows[0]);
    },

    deleteNote: async function (id) {
      var rows = await run(db().from('notes').delete().eq('id', id).select());
      if (!rows || !rows.length) throw new Error('删除未生效：记录不存在或不属于当前账号');
      return true;
    },

    getByIds: async function (ids) {
      var list = (ids || []).filter(function (n) { return Number.isFinite(Number(n)); });
      if (!list.length) return [];
      var rows = await run(db().from('notes').select('id, title, kind, summary, content').in('id', list));
      return (rows || []).map(normalize);
    },

    /** 未完成待办数量（用于侧栏角标） */
    countOpenTodos: async function () {
      var res = await db().from('notes')
        .select('id', { count: 'exact', head: true })
        .eq('kind', 'todo')
        .neq('status', 'done');
      if (res && res.error) throw friendly(res.error);
      return res && typeof res.count === 'number' ? res.count : 0;
    },

    /* ---------------- 阶段洞察 ---------------- */

    listInsights: async function (limit) {
      var rows = await run(db().from('insights').select('*')
        .order('created_at', { ascending: false })
        .limit(limit || 20));
      return (rows || []).map(function (row) {
        return {
          id: Number(row.id),
          period: row.period || '7d',
          title: row.title || '阶段总结',
          summary: row.summary || '',
          highlights: Array.isArray(row.highlights) ? row.highlights : [],
          actions: Array.isArray(row.actions) ? row.actions : [],
          note_count: Number(row.note_count || 0),
          created_at: row.created_at
        };
      });
    },

    createInsight: async function (payload) {
      var rows = await run(db().from('insights').insert({
        period: payload.period,
        title: payload.title,
        summary: payload.summary,
        highlights: payload.highlights || [],
        actions: payload.actions || [],
        note_count: payload.note_count || 0
      }).select());
      if (!rows || !rows.length) throw new Error('总结保存失败，请重试');
      return rows[0];
    },

    deleteInsight: async function (id) {
      var rows = await run(db().from('insights').delete().eq('id', id).select());
      if (!rows || !rows.length) throw new Error('删除未生效：总结不存在或不属于当前账号');
      return true;
    }
  };

  K.db = dbApi;
})();
