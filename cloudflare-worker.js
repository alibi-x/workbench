/**
 * Cloudflare Worker: 企业微信机器人推送服务 for Study Workbench
 *
 * 工作流程：
 *   Cron 每分钟触发 → 查询 Supabase 获取到期待办 → 企业微信机器人 Webhook 推送到微信 → 标记已通知
 *
 * Endpoints:
 *   GET  /          - Health check
 *   POST /test      - 立即发送一条测试消息到企业微信
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

/* ====== Cron Handler ====== */

async function handleCron(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY || !env.SUPABASE_USERKEY) {
    console.log('[Cron] Supabase not configured, skipping');
    return;
  }

  const allData = await fetchPlansFromSupabase(env);
  if (!allData || !allData.wb_plans) {
    console.log('[Cron] No plans data found');
    return;
  }

  const plans = allData.wb_plans;
  const now = Date.now();
  let sentCount = 0;
  let updated = false;

  /* 遍历所有日期的待办 */
  for (const dateKey in plans) {
    const dayPlans = plans[dateKey];
    if (!Array.isArray(dayPlans)) continue;

    for (let i = 0; i < dayPlans.length; i++) {
      const p = dayPlans[i];
      if (!p || p.done || p.notified || !p.remindAt) continue;

      const remindTime = new Date(p.remindAt).getTime();
      if (isNaN(remindTime) || remindTime > now) continue;
      /* 只推送过去 2 小时内到期的待办，避免堆积的旧待办一次性推送 */
      if (remindTime < now - 2 * 60 * 60 * 1000) continue;

      /* 到期未通知的待办，发送企业微信推送 */
      const timeStr = p.remindAt.replace('T', ' ');
      const content = '\u23F0 待办提醒\n\n' + p.text + '\n\n提醒时间：' + timeStr;

      const ok = await sendWecomMessage(env, content);
      if (ok) {
        plans[dateKey][i].notified = true;
        sentCount++;
        updated = true;
      }
    }
  }

  /* 如果有通知被发送，更新 Supabase */
  if (updated) {
    allData.wb_plans = plans;
    await updatePlansInSupabase(env, allData);
  }

  console.log('[Cron] Done: sent=' + sentCount);
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
    if (url.pathname === '/' && request.method === 'GET') {
      return json({ service: 'workbench-push', status: 'ok', push: 'wecom' });
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env) {
    await handleCron(env);
  }
};
