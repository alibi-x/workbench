/**
 * Cloudflare Worker: 企业微信机器人推送服务 for Study Workbench
 *
 * 工作流程：
 *   Cron 每分钟触发：
 *     1) 到期待办提醒 → 查询 Supabase 获取到期待办 → 企业微信机器人 Webhook 推送到微信 → 标记已通知
 *     2) 每日计划汇总 → 每天 09:00 / 16:00 / 21:00（北京时间）把当天计划整体再提醒一遍，
 *        「已完成」与「未完成」都列出；未完成且已超过提醒时间的计划加 🚨 表情符高亮
 *
 * Endpoints:
 *   GET  /            - Health check
 *   POST /test        - 立即发送一条测试消息到企业微信
 *   GET  /debug       - 诊断：secrets 状态 + 待推送队列
 *   GET  /cron-check  - 手动触发一次 handleCron，返回推送与汇总结果
 *
 * Required environment variables (via `wrangler secret put` or dashboard):
 *   SUPABASE_URL     - Supabase REST API URL (e.g. https://xxx.supabase.co/rest/v1)
 *   SUPABASE_KEY     - Supabase publishable key
 *   SUPABASE_USERKEY - 用户同步密码（与工作台中配置的一致）
 *   WECOM_WEBHOOK    - 企业微信群机器人 Webhook URL
 *
 * wrangler.toml:
 *   name = "workbench-push"
 *   main = "cloudflare-worker.js"
 *   compatibility_date = "2024-01-01"
 *
 *   [triggers]
 *   crons = ["* * * * *"]
 *
 * 说明：
 *   - 时区：所有提醒时间按北京时间（UTC+8）解析；每日汇总时段也按北京时间判断。
 *   - 防重复：汇总成功后写入 wb_summary_log（{ 'YYYY-MM-DD': ['09:00','16:00','21:00'] }），
 *     同一时段的漏拍/补跑不会重复推送。
 */

/* ====== CORS helper ====== */

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

/* ====== Supabase helpers ====== */

function supabaseHeaders(env) {
  return {
    'apikey': env.SUPABASE_KEY,
    'Authorization': 'Bearer ' + env.SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

async function fetchPlansFromSupabase(env) {
  /* 查询 workbench_data 表，获取用户数据 */
  const url = env.SUPABASE_URL + '/workbench_data?user_key=eq.' + encodeURIComponent(env.SUPABASE_USERKEY) + '&select=data';
  const resp = await fetch(url, { headers: supabaseHeaders(env) });
  if (!resp.ok) {
    console.log('[Supabase] fetch failed: ' + resp.status);
    return null;
  }
  const rows = await resp.json();
  if (!rows || rows.length === 0) return null;
  return rows[0].data;
}

async function updatePlansInSupabase(env, allData) {
  const url = env.SUPABASE_URL + '/workbench_data?user_key=eq.' + encodeURIComponent(env.SUPABASE_USERKEY);
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders(env),
    body: JSON.stringify({ data: allData, updated_at: new Date().toISOString() })
  });
  return resp.ok;
}

/* ====== 企业微信机器人推送 ====== */

async function sendWecomMessage(env, content) {
  if (!env.WECOM_WEBHOOK) {
    console.log('[Wecom] No webhook URL configured');
    return false;
  }

  const msg = {
    msgtype: 'text',
    text: {
      content: content
    }
  };

  try {
    const resp = await fetch(env.WECOM_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg)
    });

    const data = await resp.json();
    if (data.errcode === 0) {
      console.log('[Wecom] Message sent successfully');
      return true;
    } else {
      console.log('[Wecom] Send failed: ' + JSON.stringify(data));
      return false;
    }
  } catch (e) {
    console.log('[Wecom] Exception: ' + e.message);
    return false;
  }
}

/* ====== 时间/计划工具 ====== */

/* 把 datetime-local 字符串（如 2026-09-10T08:30）按北京时间解析为时间戳 */
function parseRemindTime(remindAt) {
  if (!remindAt) return NaN;
  const tzAware = /[+-]\d{2}:\d{2}$/.test(remindAt) || remindAt.endsWith('Z') ? remindAt : remindAt + '+08:00';
  return new Date(tzAware).getTime();
}

/* 构造项目标签：【项目名】或【项目名/子任务】 */
function buildTag(p, projects) {
  if (p.projectIdx == null || !projects || !projects[p.projectIdx]) return '';
  const proj = projects[p.projectIdx];
  let t = proj.name || '';
  if (p.subIdx != null && proj.subTasks && proj.subTasks[p.subIdx] && proj.subTasks[p.subIdx].name) {
    t += '/' + proj.subTasks[p.subIdx].name;
  }
  return t ? '【' + t + '】' : '';
}

/* 提醒时间展示：当天只显示 HH:MM，跨天显示日期 */
function fmtRemind(it, dateStr) {
  if (!it.remindAt) return '';
  const rd = it.remindAt.substring(0, 10);
  const hm = it.remindAt.length >= 16 ? it.remindAt.substring(11, 16) : '';
  if (rd === dateStr) return ' 🔔' + hm;
  const dayNote = rd < dateStr ? '逾期待办 ' : '';
  return ' 🔔' + dayNote + rd.slice(5) + ' ' + hm;
}

/* ====== 每日计划汇总提醒（北京时间 09:00 / 16:00 / 21:00） ====== */

const SUMMARY_SLOTS = [9, 16, 21];

function buildSummaryContent(slotKey, dateStr, done, undone, total, overdueCount) {
  const doneList = done.slice(0, 25);
  const undoneList = undone.slice(0, 35);
  const doneOmit = done.length - doneList.length;
  const undoneOmit = undone.length - undoneList.length;

  const lines = [];
  lines.push('\u{1F4CB} 今日计划汇总（' + slotKey + '）');
  lines.push('已完成 ' + done.length + '/' + total + '，未完成 ' + undone.length + '/' + total + (overdueCount > 0 ? '（超时 ' + overdueCount + ' 项）' : ''));
  lines.push('——————————————');

  lines.push('✅ 已完成');
  if (doneList.length === 0) lines.push('  （无）');
  doneList.forEach((it, i) => lines.push('  ' + (i + 1) + '. ' + it.label));
  if (doneOmit > 0) lines.push('  …还有 ' + doneOmit + ' 项已完成');
  lines.push('——————————————');

  lines.push('⏳ 未完成' + (overdueCount > 0 ? '（🚨=已超时）' : ''));
  if (undoneList.length === 0) lines.push('  （无）');
  undoneList.forEach((it, i) => {
    const flag = it.overdue ? '🚨 ' : '  ';
    const overNote = it.overdue ? ' ⏰已超时' : '';
    lines.push('  ' + (i + 1) + '. ' + flag + it.label + fmtRemind(it, dateStr) + overNote);
  });
  if (undoneOmit > 0) lines.push('  …还有 ' + undoneOmit + ' 项未完成');

  lines.push('——————————————');
  lines.push('加油，今天也要完成计划！💪');

  let content = lines.join('\n');
  /* 超长保护：企微文本消息上限约 2048 字节 */
  if (new TextEncoder().encode(content).length > 2000) {
    content = '\u{1F4CB} 今日计划汇总（' + slotKey + '）\n已完成 ' + done.length + '/' + total + '，未完成 ' + undone.length + '/' + total + '（超时 ' + overdueCount + ' 项）\n今日计划较多，请在网页端查看详情～';
  }
  return content;
}

/**
 * 每日计划汇总：
 * - 汇总范围 = 「今日计划」页同口径：当天日期的计划（不含已顺延标记项）
 *   + 早前日期中提醒日 >= 当天 且未完成未顺延的计划（跨天展示）
 * - 已完成 / 未完成分开列出；未完成且提醒时间已过 → 超时，加 🚨 高亮
 * - 防重复：成功发送后写入 wb_summary_log，同一日期同一时段只发一次
 */
async function handleDailySummary(env, allData, nowTs) {
  const now = nowTs || Date.now();
  const bj = new Date(now + 8 * 3600 * 1000); /* 用 UTC getter 读取即为北京时间 */
  const dateStr = bj.toISOString().slice(0, 10);
  const hour = bj.getUTCHours();
  const minute = bj.getUTCMinutes();

  if (!SUMMARY_SLOTS.includes(hour)) return { action: 'skip', reason: 'not-summary-time' };
  if (minute > 10) return { action: 'skip', reason: 'outside-window' };

  const slotKey = String(hour).padStart(2, '0') + ':00';
  const log = (allData.wb_summary_log && typeof allData.wb_summary_log === 'object') ? allData.wb_summary_log : {};
  if (log[dateStr] && Array.isArray(log[dateStr]) && log[dateStr].includes(slotKey)) {
    return { action: 'skip', reason: 'already-sent', slot: slotKey, date: dateStr };
  }

  const plans = allData.wb_plans || {};
  const projects = Array.isArray(allData.wb_projects) ? allData.wb_projects : [];
  const done = [];
  const undone = [];

  const collect = (p) => {
    if (!p || p.rolled) return;
    const label = buildTag(p, projects) + (p.text || '');
    if (p.done) {
      done.push({ label: label, remindAt: p.remindAt || null });
      return;
    }
    const rt = parseRemindTime(p.remindAt);
    undone.push({
      label: label,
      remindAt: p.remindAt || null,
      remindTime: rt,
      overdue: !Number.isNaN(rt) && rt < now
    });
  };

  /* 1) 当天日期的计划 */
  if (Array.isArray(plans[dateStr])) plans[dateStr].forEach(collect);

  /* 2) 跨天展示：早前日期中提醒日 >= 当天 且未完成未顺延 */
  for (const dk in plans) {
    if (dk >= dateStr || !Array.isArray(plans[dk])) continue;
    plans[dk].forEach((p) => {
      if (!p || p.done || p.rolled || !p.remindAt) return;
      if (p.remindAt.substring(0, 10) >= dateStr) collect(p);
    });
  }

  const total = done.length + undone.length;
  if (total === 0) return { action: 'skip', reason: 'no-plans-today', slot: slotKey, date: dateStr };

  /* 未完成排序：已超时优先（按超时时间从早到晚），其次按提醒时间 */
  undone.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const ta = Number.isNaN(a.remindTime) ? Infinity : a.remindTime;
    const tb = Number.isNaN(b.remindTime) ? Infinity : b.remindTime;
    return ta - tb;
  });

  const overdueCount = undone.filter((x) => x.overdue).length;
  const content = buildSummaryContent(slotKey, dateStr, done, undone, total, overdueCount);

  const ok = await sendWecomMessage(env, content);
  if (!ok) {
    return { action: 'failed', slot: slotKey, date: dateStr, total: total, done: done.length, undone: undone.length, overdue: overdueCount };
  }

  /* 记录本时段已发送，防止重复 */
  log[dateStr] = log[dateStr] || [];
  log[dateStr].push(slotKey);
  allData.wb_summary_log = log;

  return { action: 'sent', slot: slotKey, date: dateStr, total: total, done: done.length, undone: undone.length, overdue: overdueCount };
}

/* ====== Cron Handler ====== */

async function handleCron(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY || !env.SUPABASE_USERKEY) {
    return { error: 'Supabase not configured' };
  }

  const allData = await fetchPlansFromSupabase(env);
  if (!allData || !allData.wb_plans) {
    return { error: 'No plans data found' };
  }

  const plans = allData.wb_plans;
  const now = Date.now();
  let sentCount = 0;
  let updated = false;
  const details = [];

  /* 遍历所有日期的待办 */
  for (const dateKey in plans) {
    const dayPlans = plans[dateKey];
    if (!Array.isArray(dayPlans)) continue;

    for (let i = 0; i < dayPlans.length; i++) {
      const p = dayPlans[i];
      if (!p || p.done || p.notified || !p.remindAt) continue;

      const remindTime = parseRemindTime(p.remindAt);
      if (Number.isNaN(remindTime) || remindTime > now) continue;
      /* 只推送过去 2 小时内到期的待办，避免堆积的旧待办一次性推送 */
      if (remindTime < now - 2 * 60 * 60 * 1000) continue;

      /* 到期未通知的待办，发送企业微信推送 */
      const timeStr = p.remindAt.replace('T', ' ');
      const content = '\u23F0 待办提醒\n\n' + p.text + '\n\n提醒时间：' + timeStr;

      const ok = await sendWecomMessage(env, content);
      details.push({ text: p.text, remindAt: p.remindAt, sent: ok });
      if (ok) {
        plans[dateKey][i].notified = true;
        sentCount++;
        updated = true;
      }
    }
  }

  /* 每日计划汇总：北京时间 09:00 / 16:00 / 21:00 */
  const summary = await handleDailySummary(env, allData, now);
  if (summary.action === 'sent') updated = true;

  /* 如果有变化，更新 Supabase（含 notified 标记与汇总发送日志） */
  if (updated) {
    allData.wb_plans = plans;
    await updatePlansInSupabase(env, allData);
  }

  console.log('[Cron] Done: sent=' + sentCount + ', summary=' + summary.action);
  return { sent: sentCount, details: details, summary: summary };
}

/* ====== Diagnostics ====== */

async function handleDebug(env) {
  const result = {
    timestamp: new Date().toISOString(),
    secrets: {
      SUPABASE_URL: env.SUPABASE_URL ? 'SET' : 'NOT SET',
      SUPABASE_KEY: env.SUPABASE_KEY ? 'SET' : 'NOT SET',
      SUPABASE_USERKEY: env.SUPABASE_USERKEY ? 'SET' : 'NOT SET',
      WECOM_WEBHOOK: env.WECOM_WEBHOOK ? 'SET' : 'NOT SET'
    }
  };

  if (!env.SUPABASE_URL || !env.SUPABASE_KEY || !env.SUPABASE_USERKEY) {
    result.error = 'Supabase secrets not fully configured';
    return json(result);
  }

  try {
    const allData = await fetchPlansFromSupabase(env);
    if (!allData) {
      result.supabase = 'No data row found for this user_key';
      result.hint = 'Check: 1) SUPABASE_USERKEY matches your sync password  2) You have uploaded data via sync';
      return json(result);
    }

    result.supabase = 'Data found';
    result.data_keys = Object.keys(allData);
    result.has_wb_plans = !!allData.wb_plans;

    if (allData.wb_plans) {
      const plans = allData.wb_plans;
      const now = Date.now();
      const dueItems = [];

      for (const dateKey in plans) {
        const dayPlans = plans[dateKey];
        if (!Array.isArray(dayPlans)) continue;
        for (let i = 0; i < dayPlans.length; i++) {
          const p = dayPlans[i];
          if (!p || p.done || p.notified || !p.remindAt) continue;
          const remindTime = parseRemindTime(p.remindAt);
          if (Number.isNaN(remindTime)) continue;
          dueItems.push({
            date: dateKey,
            index: i,
            text: p.text,
            remindAt: p.remindAt,
            ageMinutes: Math.round((now - remindTime) / 60000),
            inWindow: remindTime > now - 2 * 60 * 60 * 1000 && remindTime <= now
          });
        }
      }

      result.due_not_notified = dueItems;
      result.due_count = dueItems.length;
      result.now = new Date().toISOString();

      if (dueItems.length === 0) {
        result.hint = 'No due un-notified items found. Possible reasons: all notified already, no remindAt set, or items older than 2h window';
      }
    }

    /* 汇总发送日志（用于确认每日 9/16/21 点汇总是否已推） */
    result.summary_log = allData.wb_summary_log || {};

    return json(result);
  } catch (e) {
    result.error = 'Supabase query failed: ' + e.message;
    return json(result);
  }
}

/* ====== HTTP Handlers ====== */

async function handleTest(env) {
  if (!env.WECOM_WEBHOOK) {
    return json({ error: 'WECOM_WEBHOOK not configured' }, 400);
  }
  const ok = await sendWecomMessage(env, '\u2705 测试通知\n\n这是来自工作台的测试消息，如果你能在微信看到这条消息，说明推送配置成功！');
  if (ok) {
    return json({ ok: true, message: 'Test message sent to WeChat' });
  } else {
    return json({ ok: false, error: 'Failed to send message' }, 500);
  }
}

/* ====== Entry Point ====== */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    if (url.pathname === '/test' && request.method === 'POST') {
      return handleTest(env);
    }
    if (url.pathname === '/test' && request.method === 'GET') {
      return handleTest(env);
    }
    if (url.pathname === '/debug' && request.method === 'GET') {
      return handleDebug(env);
    }
    if (url.pathname === '/cron-check' && request.method === 'GET') {
      const result = await handleCron(env);
      return json(result);
    }
    if (url.pathname === '/' && request.method === 'GET') {
      return json({ service: 'workbench-push', status: 'ok', push: 'wecom' });
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env) {
    await handleCron(env);
  }
};