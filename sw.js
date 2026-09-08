const CACHE_VERSION = 'v2.1.0';
const CACHE_NAME = 'workbench-' + CACHE_VERSION;
const ASSETS = [
  './study-workbench.html',
  './manifest.json',
  './cover-workbench-v2.png',
  './icon-workbench-192.png',
  './icon-workbench-512.png'
];

// 安装：预缓存核心文件
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// 激活：清理旧版本缓存，接管控制权
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// 请求拦截：网络优先，失败回退缓存
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) {
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => {
        return caches.match(e.request).then(cached => cached || caches.match('./study-workbench.html'));
      })
  );
});

// 收到更新消息时通知客户端刷新
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

// === 原生 Web Push 事件处理 ===

// 收到推送通知
self.addEventListener('push', e => {
  var payload = { title: '\u23f0 \u5f85\u529e\u63d0\u9192', body: '\u4f60\u6709\u4e00\u6761\u5f85\u529e\u9700\u8981\u5904\u7406' };
  if (e.data) {
    try { payload = e.data.json(); } catch(err) {
      try { payload.body = e.data.text(); } catch(e2) {}
    }
  }
  e.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: './icon-workbench-192.png',
      badge: './icon-workbench-192.png',
      tag: payload.tag || 'workbench-todo',
      data: { url: payload.url || './study-workbench.html' },
      vibrate: [200, 100, 200],
      requireInteraction: true
    })
  );
});

// 点击通知后打开页面
self.addEventListener('notificationclick', e => {
  e.notification.close();
  var targetUrl = (e.notification.data && e.notification.data.url) || './study-workbench.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf(targetUrl) >= 0 && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
