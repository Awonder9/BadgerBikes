import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCATION } from '../config'

type WatchCallback = (pos: unknown, err?: unknown) => void
const plugin = vi.hoisted(() => ({
  watchPosition: vi.fn<(options: object, callback: WatchCallback) => Promise<string>>(),
  clearWatch: vi.fn<(options: { id: string }) => Promise<void>>(),
  checkPermissions: vi.fn<() => Promise<{ location: string; coarseLocation: string }>>(),
}))
vi.mock('../native', () => ({ nativePlugins: () => Promise.resolve({ Geolocation: plugin }) }))

const { geoSource, locationAllowed, nativeGeoError } = await import('./geoSource')

const position = { timestamp: 1_800_000_000_000, coords: { latitude: 43.07, longitude: -89.4, accuracy: 12, heading: null, speed: -1 } }
const fix = { coord: [-89.4, 43.07], accuracy: 12, heading: null, speed: null, timestampMs: 1_800_000_000_000 }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('where positions come from', () => {
  it('the apps use the location plugin (precise, so Android doesn’t ask only for approximate location)', async () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    plugin.watchPosition.mockResolvedValue('watch-1')
    const fixes: unknown[] = []
    const errors: string[] = []
    const stop = geoSource()!.watch(
      (f) => fixes.push(f),
      (e) => errors.push(e),
    )
    await flush()
    const [options, callback] = plugin.watchPosition.mock.calls[0]!
    expect(options).toMatchObject({ enableHighAccuracy: LOCATION.nativeHighAccuracy, interval: LOCATION.nativeIntervalMs, timeout: LOCATION.timeoutMs })
    callback(position)
    callback(null, { code: 'OS-PLUG-GLOC-0003', message: 'Location permission request was denied.' })
    expect(fixes).toEqual([fix])
    expect(errors).toEqual(['geo_denied'])
    stop()
    await flush()
    expect(plugin.clearWatch).toHaveBeenCalledWith({ id: 'watch-1' })
    callback(position) // after stop: ignored
    expect(fixes).toHaveLength(1)
  })

  it('maps the plugin’s errors; location off for the whole phone counts as denied, as in Safari', () => {
    const code = (c: string) => nativeGeoError({ code: c })
    expect(['0003', '0007', '0008', '0009', '0010', '0002'].map((c) => code(`OS-PLUG-GLOC-${c}`))).toEqual(['geo_denied', 'geo_denied', 'geo_denied', 'geo_denied', 'geo_timeout', 'geo_unavailable'])
    expect([nativeGeoError(new Error('boom')), nativeGeoError(undefined)]).toEqual(['geo_unavailable', 'geo_unavailable'])
  })

  it('a browser uses its own Geolocation API', () => {
    const geo = {
      watchPosition: vi.fn<(ok: (p: unknown) => void, fail: (e: { code: number }) => void) => number>((ok, fail) => (ok(position), fail({ code: 1 }), 7)),
      clearWatch: vi.fn<(id: number) => void>(),
    }
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { geolocation: geo })
    const got: unknown[] = []
    const stop = geoSource()!.watch(
      (f) => got.push(f),
      (e) => got.push(e),
    )
    stop()
    expect(got).toEqual([fix, 'geo_denied'])
    expect(geo.clearWatch).toHaveBeenCalledWith(7)
    expect(plugin.watchPosition).not.toHaveBeenCalled()
  })

  it('tells whether location is already allowed without asking', async () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    plugin.checkPermissions.mockResolvedValueOnce({ location: 'granted', coarseLocation: 'granted' }).mockResolvedValueOnce({ location: 'prompt', coarseLocation: 'prompt' })
    plugin.checkPermissions.mockRejectedValueOnce({ code: 'OS-PLUG-GLOC-0007' }) // location services off
    expect([await locationAllowed(), await locationAllowed(), await locationAllowed()]).toEqual([true, false, false])
  })
})
