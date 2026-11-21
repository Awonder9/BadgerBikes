import { describe, expect, it } from 'vitest'
import { colorSchemeSnapshot, isDarkStyle } from './useMediaQuery'

describe('color scheme', () => {
  it('ignores the flips iOS makes while the app is in the background, and re-reads it on return', () => {
    let dark = colorSchemeSnapshot(true, true, null) // dark at launch
    expect(dark).toBe(true)
    dark = colorSchemeSnapshot(false, false, dark) // backgrounded: iOS flips to light for a snapshot
    expect(dark).toBe(true)
    dark = colorSchemeSnapshot(true, true, dark) // back: still dark, even if the flip back was never reported
    expect(dark).toBe(true)
    dark = colorSchemeSnapshot(false, true, dark) // a real change while visible is followed
    expect(dark).toBe(false)
    expect(colorSchemeSnapshot(true, false, null)).toBe(true) // first read, even while hidden
  })

  it('auto follows the OS; light and dark are fixed', () => {
    expect(isDarkStyle('auto', true)).toBe(true)
    expect(isDarkStyle('auto', false)).toBe(false)
    expect(isDarkStyle('light', true)).toBe(false)
    expect(isDarkStyle('dark', false)).toBe(true)
  })
})
