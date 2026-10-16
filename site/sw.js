// Service worker: shows push notifications and makes the page installable. It never caches API data.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {}); // network as usual; the handler's presence is what lets Chrome offer "Install"

self.addEventListener("push", (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch { m = { title: "Research agent", body: event.data ? event.data.text() : "" }; }
  const url = typeof m.url === "string" ? m.url : "/";
  event.waitUntil(self.registration.showNotification(String(m.title || "Research agent").slice(0, 120), {
    body: String(m.body || "").slice(0, 300), tag: m.tag || undefined, icon: "/icon-192.png", badge: "/icon-192.png", data: { url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    let target = new URL("/", self.location.origin).href;
    try { const u = new URL(raw, self.location.origin); if (u.protocol === "https:" || u.protocol === "http:") target = u.href; } catch { /* keep home */ }
    const same = new URL(target).origin === self.location.origin;
    if (same) {
      for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
        if (new URL(c.url).origin === self.location.origin) { await c.navigate(target).catch(() => {}); return c.focus(); }
      }
    }
    return self.clients.openWindow(target);
  })());
});
