import { afterEach, describe, expect, it, vi } from 'vitest'
import { canHandOverFiles, isNativeApp, isStandalone, shareOrigin } from './platform'

/** A page: in a browser tab, or in the native apps' web view (whose bridge defines window.Capacitor first). */
function page({ native, origin, canShare }: { native: boolean; origin: string; canShare?: (data: ShareData) => boolean }) {
  vi.stubGlobal('window', {
    location: { origin },
    matchMedia: () => ({ matches: false }),
    ...(native ? { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' } } : {}),
  })
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)', maxTouchPoints: 5, ...(canShare ? { canShare } : {}) })
}

const sharesFiles = (data: ShareData) => (data.files?.length ?? 0) > 0

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the native apps', () => {
  it('are told apart from a browser tab by the bridge, and count as installed (no install tip or Home Screen steps)', () => {
    page({ native: false, origin: 'https://badgerbikes.app' })
    expect([isNativeApp(), isStandalone()]).toEqual([false, false])
    page({ native: true, origin: 'capacitor://localhost' })
    expect([isNativeApp(), isStandalone()]).toEqual([true, true])
  })

  it('a web page shares links to its own origin (the native build points them at the deployed site instead)', () => {
    page({ native: false, origin: 'https://badgerbikes.app' })
    expect(shareOrigin()).toBe('https://badgerbikes.app')
  })

  it('offer the GPX file only where the web view can share it, since it cannot download', () => {
    page({ native: false, origin: 'https://badgerbikes.app' })
    expect(canHandOverFiles()).toBe(true) // a browser downloads what it can't share
    page({ native: true, origin: 'capacitor://localhost', canShare: sharesFiles })
    expect(canHandOverFiles()).toBe(true) // iOS: the share sheet
    page({ native: true, origin: 'https://localhost' })
    expect(canHandOverFiles()).toBe(false) // Android's web view: no Web Share
    page({ native: true, origin: 'https://localhost', canShare: () => false })
    expect(canHandOverFiles()).toBe(false)
  })
})
