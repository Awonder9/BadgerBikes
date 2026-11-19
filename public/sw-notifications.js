// Imported by the generated service worker (vite.config.ts → workbox.importScripts).
//
// Background ride alerts: the Worker pushes { title, body, tag } (worker/rideAlerts.ts), encrypted for this
// browser. They are shown as plain-text notifications; a tag shared with the in-app alerts replaces rather
// than stacks. Tapping any ride alert brings the app back to the front.
const text = (value, fallback) => (typeof value === 'string' && value.length > 0 && value.length <= 300 ? value : fallback)

self.addEventListener('push', (event) => {
  let data = null
  try {
    data = event.data ? event.data.json() : null
  } catch {
    data = null
  }
  if (!data || typeof data !== 'object') data = {} // a `null`, number or string payload
  event.waitUntil(self.registration.showNotification(text(data.title, 'Badger Bikes'), { body: text(data.body, ''), tag: text(data.tag, 'ride'), icon: '/icons/icon-192.png' }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => 'focus' in w)
      return open ? open.focus() : self.clients.openWindow('/')
    }),
  )
})
