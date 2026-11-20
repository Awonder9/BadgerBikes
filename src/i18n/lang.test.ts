import { describe, expect, it } from 'vitest'
import { detectLang, resolveLang } from './lang'

describe('detectLang', () => {
  it('maps Chinese tags to Simplified or Traditional', () => {
    expect(detectLang(['zh-CN'])).toBe('zh-Hans')
    expect(detectLang(['zh'])).toBe('zh-Hans')
    expect(detectLang(['zh-Hans-US'])).toBe('zh-Hans')
    expect(detectLang(['zh-SG'])).toBe('zh-Hans')
    expect(detectLang(['zh-TW'])).toBe('zh-Hant')
    expect(detectLang(['zh-HK'])).toBe('zh-Hant')
    expect(detectLang(['zh-Hant-US'])).toBe('zh-Hant')
    expect(detectLang(['zh-MO'])).toBe('zh-Hant')
  })

  it('lets the script decide over the region (iPhone: Simplified Chinese with the region set to Hong Kong)', () => {
    expect(detectLang(['zh-Hans-HK'])).toBe('zh-Hans')
    expect(detectLang(['zh-Hans-TW'])).toBe('zh-Hans')
    expect(detectLang(['zh-Hant-CN'])).toBe('zh-Hant')
  })

  it('uses the first supported language and falls back to English', () => {
    expect(detectLang(['en-US', 'zh-CN'])).toBe('en')
    expect(detectLang(['fr-FR', 'zh-TW', 'en'])).toBe('zh-Hant')
    expect(detectLang(['fr-FR'])).toBe('en')
    expect(detectLang([])).toBe('en')
  })
})

describe('resolveLang', () => {
  it('follows the system only when set to auto', () => {
    expect(resolveLang('auto', ['zh-TW'])).toBe('zh-Hant')
    expect(resolveLang('en', ['zh-TW'])).toBe('en')
    expect(resolveLang('zh-Hans', ['en-US'])).toBe('zh-Hans')
  })
})
