import { afterEach, describe, expect, it, vi } from 'vitest'

const plugin = vi.hoisted(() => ({
  cancel: vi.fn<(options: unknown) => Promise<void>>(async () => {}),
  // Android 7: notification channels don't exist, and the plugin says so.
  createChannel: vi.fn<(options: unknown) => Promise<void>>(async () => {
    throw Object.assign(new Error('Not available on this device'), { code: 'UNAVAILABLE' })
  }),
  schedule: vi.fn<(options: { notifications: Array<Record<string, unknown>> }) => Promise<unknown>>(async () => ({ notifications: [] })),
  checkExactNotificationSetting: vi.fn<() => Promise<{ exact_alarm: string }>>(async () => ({ exact_alarm: 'granted' })),
}))
vi.mock('.', () => ({ nativePlugins: () => Promise.resolve({ LocalNotifications: plugin }) }))
vi.mock('../ui/platform', () => ({ platform: () => 'android' }))

const { scheduleTimerAlerts, showAlertNow } = await import('./notifications')

afterEach(() => {
  vi.clearAllMocks()
})

describe('ride alerts on the phone', () => {
  it('are scheduled on Android 7 too, which has no notification channels', async () => {
    scheduleTimerAlerts([{ kind: 'warn', atMs: Date.now() + 60_000, title: 'Ride time almost up', body: '5 min left' }], 'Ride alerts', true)
    await vi.waitFor(() => expect(plugin.schedule).toHaveBeenCalledTimes(1))
    expect(plugin.createChannel).toHaveBeenCalled()
    expect(plugin.schedule.mock.calls[0]?.[0].notifications).toMatchObject([{ id: 1, title: 'Ride time almost up', isExactNotification: true, channelId: 'ride-alerts' }])
    showAlertNow('full', 'Your end dock is full', 'Pick another dock', 'Ride alerts')
    await vi.waitFor(() => expect(plugin.schedule).toHaveBeenCalledTimes(2))
  })

  it('replace the previous ones; none cancels them', async () => {
    scheduleTimerAlerts([], 'Ride alerts', null)
    await vi.waitFor(() => expect(plugin.cancel).toHaveBeenCalledWith({ notifications: [{ id: 1 }, { id: 2 }] }))
    expect(plugin.schedule).not.toHaveBeenCalled()
  })
})
