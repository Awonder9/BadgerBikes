import { describe, expect, it } from 'vitest'

// public/sw-notifications.js runs inside the generated service worker (vite.config.ts → workbox.importScripts).
// It is run here against a fake `self` to check what a pushed ride alert turns into.
const source = Object.values(import.meta.glob<string>('../../../public/sw-notifications.js', { query: '?raw', import: 'default', eager: true }))[0]!

type Handler = (event: unknown) => void

function serviceWorker(openWindows: Array<{ focus: () => Promise<void> }> = []) {
  const handlers: Record<string, Handler> = {}
  const shown: Array<[string, NotificationOptions]> = []
  const opened: string[] = []
  const self = {
    addEventListener: (type: string, handler: Handler) => void (handlers[type] = handler),
    registration: { showNotification: async (title: string, options: NotificationOptions) => void shown.push([title, options]) },
    clients: { matchAll: async () => openWindows, openWindow: async (url: string) => void opened.push(url) },
  }
  // oxlint-disable-next-line no-new-func -- evaluating the service worker script under test
  new Function('self', source)(self)
  /** Dispatches an event and resolves once its waitUntil work is done. */
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    let work: Promise<unknown> = Promise.resolve()
    handlers[type]!({ ...event, waitUntil: (p: Promise<unknown>) => void (work = p) })
    await work
  }
  return { shown, opened, dispatch }
}

describe('service worker: background ride alerts', () => {
  it('shows a pushed alert as plain text, with its tag (so it replaces the in-app one)', async () => {
    const sw = serviceWorker()
    const alert = { title: 'Your end dock is full', body: '<b>Dock & Co</b> has no open docks.', tag: 'dock-full' }
    await sw.dispatch('push', { data: { json: () => alert } })
    expect(sw.shown).toEqual([['Your end dock is full', { body: '<b>Dock & Co</b> has no open docks.', tag: 'dock-full', icon: '/icons/icon-192.png' }]])
  })

  it('still shows something sensible for an empty or malformed push (browsers require a notification)', async () => {
    const sw = serviceWorker()
    await sw.dispatch('push', { data: null })
    await sw.dispatch('push', { data: { json: () => JSON.parse('not json') } })
    await sw.dispatch('push', { data: { json: () => ({ title: 42, body: 'x'.repeat(5000) }) } })
    await sw.dispatch('push', { data: { json: () => null } })
    expect(sw.shown.map(([title, o]) => [title, o.body, o.tag])).toEqual([
      ['Badger Bikes', '', 'ride'],
      ['Badger Bikes', '', 'ride'],
      ['Badger Bikes', '', 'ride'],
      ['Badger Bikes', '', 'ride'],
    ])
  })

  it('tapping an alert brings the open app to the front, or opens it', async () => {
    let focused = 0
    const withApp = serviceWorker([{ focus: async () => void focused++ }])
    const close = () => {}
    await withApp.dispatch('notificationclick', { notification: { close } })
    expect(focused).toBe(1)
    const without = serviceWorker()
    await without.dispatch('notificationclick', { notification: { close } })
    expect(without.opened).toEqual(['/'])
  })
})
