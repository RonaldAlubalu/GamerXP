// Shows notifications from the admin (new request, message, payment) and opens the right page on a tap.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: 'Gamer Xperience', body: '', url: '#/board' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/assets/img/logo.png',
      badge: '/assets/favicon.png',
      data: { url: data.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = `/admin/${event.notification.data?.url ?? ''}`;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).pathname.startsWith('/admin'));
      if (open) return open.navigate(target).then((w) => (w ?? open).focus());
      return self.clients.openWindow(target);
    }),
  );
});
