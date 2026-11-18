// Imported by the generated service worker (vite.config.ts → workbox.importScripts). Ride alerts are shown
// through the service worker (src/ui/ride/useRideStatus.ts); tapping one brings the app back to the front.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => 'focus' in w)
      return open ? open.focus() : self.clients.openWindow('/')
    }),
  )
})
