/**
 * Cloudflare Worker: Web Push Notification Service for Study Workbench
 *
 * Endpoints:
 *   POST /schedule  - Store a scheduled notification {text, remindAt, endpoint, keys}
 *   POST /cancel    - Cancel a scheduled notification {id}
 *   GET  /          - Health check
 *
 * Cron Trigger: fires every minute, checks due notifications and sends Web Push.
 *
 * Required environment variables (set via `wrangler secret put` or dashboard):
 *   VAPID_PRIVATE_KEY - PKCS#8 DER base64url private key
 *   VAPID_PUBLIC_KEY  - base64url uncompressed public key (65 bytes)
 *   VAPID_SUBJECT     - Contact URL, e.g. "mailto:user@example.com"
 *
 * KV namespace binding:
 *   NOTIFICATIONS - stores scheduled notification records
 *
 * wrangler.toml:
 *   name = "workbench-push"
 *   main = "cloudflare-worker.js"
 *   compatibility_date = "2024-01-01"
 *
 *   [triggers]
 *   crons = ["* * * * *"]
 *
 *   [[kv_namespaces]]
 *   binding = "NOTIFICATIONS"
 *   id = "<your-kv-namespace-id>"
 */

const KV_PREFIX = 'notif:';
let _cachedKey = null;

/* ====== Base64 utilities ====== */

function b64urlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - str.length % 4) % 4);
  const bin = atob(str + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function strToBytes(str) {
  return new TextEncoder().encode(str);
}

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

/* ====== VAPID JWT ====== */

async function getPrivateKey(env) {
  if (_cachedKey) return _cachedKey;
  const derBytes = b64urlToBytes(env.VAPID_PRIVATE_KEY);
  _cachedKey = await crypto.subtle.importKey(
    'pkcs8', derBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );
  return _cachedKey;
}

async function makeVapidJWT(audience, privateKey, subject) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject
  };
  const encH = bytesToB64url(strToBytes(JSON.stringify(header)));
  const encP = bytesToB64url(strToBytes(JSON.stringify(payload)));
  const signingInput = encH + '.' + encP;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey, strToBytes(signingInput)
  );
  return signingInput + '.' + bytesToB64url(new Uint8Array(sig));
}

/* ====== Web Push Encryption (RFC 8291 / aes128gcm) ====== */

async function encryptPayload(message, p256dhB64Url, authB64Url) {
  const uaPublicKey = b64urlToBytes(p256dhB64Url);  // 65-byte uncompressed point
  const authSecret = b64urlToBytes(authB64Url);      // 16 bytes
  const msgBytes = strToBytes(message);

  /* 1. Generate ephemeral ECDH key pair */
  const ecKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );

  /* 2. Import client p256dh as ECDH public key */
  const clientKey = await crypto.subtle.importKey(
    'raw', uaPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  /* 3. Compute shared secret */
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: clientKey }, ecKeys.privateKey, 256
    )
  );

  /* 4. Export ephemeral public key (raw uncompressed, 65 bytes) */
  const asPublicKey = new Uint8Array(
    await crypto.subtle.exportKey('raw', ecKeys.publicKey)
  );

  /* 5. Build key_info = "WebPush: info" || 0x00 || ua_public || as_public */
  const label = strToBytes('WebPush: info');
  const keyInfo = new Uint8Array(label.length + 1 + uaPublicKey.length + asPublicKey.length);
  keyInfo.set(label, 0);
  keyInfo[label.length] = 0;
  keyInfo.set(uaPublicKey, label.length + 1);
  keyInfo.set(asPublicKey, label.length + 1 + uaPublicKey.length);

  /* 6. IKM = HKDF(salt=auth_secret, IKM=ecdh_secret, info=key_info, L=32) */
  const ecdhKeyObj = await crypto.subtle.importKey(
    'raw', ecdhSecret, 'HKDF', false, ['deriveBits']
  );
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: keyInfo },
      ecdhKeyObj, 32
    )
  );

  /* 7. Random 16-byte salt */
  const salt = crypto.getRandomValues(new Uint8Array(16));

  /* 8. cek = HKDF(salt, IKM, "Content-Encoding: aes128gcm\0", 16) */
  const cekLabel = strToBytes('Content-Encoding: aes128gcm');
  const cekInfo = new Uint8Array(cekLabel.length + 1);
  cekInfo.set(cekLabel, 0);
  cekInfo[cekLabel.length] = 0;

  const ikmKeyObj = await crypto.subtle.importKey(
    'raw', ikm, 'HKDF', false, ['deriveBits']
  );
  const cek = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt, info: cekInfo },
    ikmKeyObj, 16
  );

  /* 9. nonce = HKDF(salt, IKM, "Content-Encoding: nonce\0", 12) */
  const nonceLabel = strToBytes('Content-Encoding: nonce');
  const nonceInfo = new Uint8Array(nonceLabel.length + 1);
  nonceInfo.set(nonceLabel, 0);
  nonceInfo[nonceLabel.length] = 0;

  const nonce = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt, info: nonceInfo },
    ikmKeyObj, 12
  );

  /* 10. Content = message || 0x02 (last-record delimiter per RFC 8188) */
  const content = new Uint8Array(msgBytes.length + 1);
  content.set(msgBytes, 0);
  content[msgBytes.length] = 2;

  /* 11. AES-128-GCM encrypt (tag is appended automatically) */
  const cekKeyObj = await crypto.subtle.importKey(
    'raw', cek, 'AES-GCM', false, ['encrypt']
  );
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      cekKeyObj, content
    )
  );

  /* 12. Build aes128gcm header: salt(16) | rs(4) | idlen(1) | keyid(65) */
  const rs = 4096;
  const hdrLen = 16 + 4 + 1 + asPublicKey.length;
  const header = new Uint8Array(hdrLen);
  header.set(salt, 0);
  new DataView(header.buffer, 16, 4).setUint32(0, rs);
  header[20] = asPublicKey.length;
  header.set(asPublicKey, 21);

  /* 13. Concatenate header + ciphertext */
  const result = new Uint8Array(hdrLen + encrypted.length);
  result.set(header, 0);
  result.set(encrypted, hdrLen);
  return result;
}

/* ====== Send Web Push ====== */

async function sendPush(env, subscription, payloadText) {
  const endpoint = subscription.endpoint;
  if (!endpoint) throw new Error('No push endpoint');

  const encBody = await encryptPayload(
    payloadText,
    subscription.keys.p256dh,
    subscription.keys.auth
  );

  const origin = new URL(endpoint).origin;
  const privKey = await getPrivateKey(env);
  const jwt = await makeVapidJWT(origin, privKey, env.VAPID_SUBJECT);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Authorization': 'vapid t=' + jwt + ',k=' + env.VAPID_PUBLIC_KEY
    },
    body: encBody
  });

  return resp;
}

/* ====== HTTP Handlers ====== */

async function handleSchedule(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { text, remindAt, endpoint, keys } = body;
  if (!text || !remindAt || !endpoint || !keys || !keys.p256dh || !keys.auth) {
    return json({ error: 'Missing required fields' }, 400);
  }

  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  await env.NOTIFICATIONS.put(KV_PREFIX + id, JSON.stringify({
    text: String(text).slice(0, 500),
    remindAt: remindAt,
    endpoint: endpoint,
    keys: keys,
    sent: false,
    created: Date.now()
  }));

  return json({ id: id });
}

async function handleCancel(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { id } = body;
  if (!id) return json({ error: 'Missing id' }, 400);

  await env.NOTIFICATIONS.delete(KV_PREFIX + id);
  return json({ ok: true });
}

/* ====== Cron Handler ====== */

async function handleCron(env) {
  const now = Date.now();
  const list = await env.NOTIFICATIONS.list({ prefix: KV_PREFIX });
  let sentCount = 0;
  let errorCount = 0;

  for (const item of list.keys) {
    const raw = await env.NOTIFICATIONS.get(item.name);
    if (!raw) continue;

    let notif;
    try { notif = JSON.parse(raw); } catch { continue; }
    if (notif.sent) continue;

    const remindTime = new Date(notif.remindAt).getTime();
    if (isNaN(remindTime) || remindTime > now) continue;

    try {
      const resp = await sendPush(
        env,
        { endpoint: notif.endpoint, keys: notif.keys },
        '\u23F0 ' + notif.text
      );

      if (resp.ok || resp.status === 410 || resp.status === 404) {
        /* 200 = delivered, 410/404 = subscription expired - remove either way */
        await env.NOTIFICATIONS.delete(item.name);
        sentCount++;
      } else if (resp.status === 429) {
        /* Rate limited - skip, will retry next minute */
        console.log('Push rate limited for ' + item.name + ', will retry');
      } else {
        console.log('Push failed (' + resp.status + ') for ' + item.name);
        /* For other errors, delete to avoid infinite retries */
        await env.NOTIFICATIONS.delete(item.name);
        errorCount++;
      }
    } catch (e) {
      console.error('Push exception for ' + item.name + ': ' + e.message);
      errorCount++;
    }
  }

  console.log('Cron done: sent=' + sentCount + ' errors=' + errorCount + ' total=' + list.keys.length);
}

/* ====== Entry Point (Module Worker syntax) ====== */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* CORS preflight */
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    if (url.pathname === '/schedule' && request.method === 'POST') {
      return handleSchedule(request, env);
    }
    if (url.pathname === '/cancel' && request.method === 'POST') {
      return handleCancel(request, env);
    }
    if (url.pathname === '/' && request.method === 'GET') {
      return json({ service: 'workbench-push', status: 'ok' });
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env) {
    await handleCron(env);
  }
};
