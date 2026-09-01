const CACHE_VERSION = 'v1.1.0';
const CACHE_NAME = 'workbench-' + CACHE_VERSION;
const ASSETS = [
  './study-workbench.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
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
  // 只处理同源 GET 请求
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) {
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // 成功获取，更新缓存副本
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => {
        // 网络失败，回退缓存
        return caches.match(e.request).then(cached => cached || caches.match('./study-workbench.html'));
      })
  );
});

// 收到更新消息时通知客户端刷新
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
