/**
 * NCE Flow Service Worker
 * 缓存策略：核心文件缓存优先，音频网络优先
 */

const CACHE_NAME = 'nce-flow-v2';

// 核心静态资源（预缓存）
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/lesson.html',
  '/book.html',
  '/assets/styles.css',
  '/assets/lesson.js',
  '/assets/app.js',
  '/static/data.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon.ico'
];

// 安装：预缓存核心资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] 预缓存核心资源');
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] 删除旧缓存:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// 请求拦截
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 只处理同源请求
  if (url.origin !== location.origin) {
    return;
  }

  // 音频文件：网络优先（不缓存）
  if (url.pathname.endsWith('.mp3')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        // 离线时返回友好提示（可选）
        return new Response('音频需要联网播放', { status: 503 });
      })
    );
    return;
  }

  // LRC 文件：网络优先，失败时用缓存
  if (url.pathname.endsWith('.lrc')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // 成功获取后更新缓存
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // 其他资源：缓存优先，失败时网络获取
  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request).then((response) => {
          // 缓存新资源（仅成功的 GET 请求）
          if (response.ok && event.request.method === 'GET') {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        });
      })
  );
});
