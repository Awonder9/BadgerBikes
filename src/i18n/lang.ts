// UI languages. Pure: callers pass in the browser's language list (navigator.languages).
export type Lang = 'en' | 'zh-Hans' | 'zh-Hant'
/** The Settings choice: 'auto' follows the system/browser language. */
export type LanguageSetting = 'auto' | Lang

export const LANGS: readonly Lang[] = ['en', 'zh-Hans', 'zh-Hant']

/** Each language's name in itself, for the Settings picker. */
export const LANG_NAMES: Record<Lang, string> = { en: 'English', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文' }

/** BCP 47 tag for <html lang> and Intl formatters. */
export const LANG_TAGS: Record<Lang, string> = { en: 'en-US', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' }

/**
 * The first supported language in the rider's preference list. Chinese: Traditional for zh-Hant and the
 * regions that write it (Taiwan, Hong Kong, Macau), otherwise Simplified. Nothing supported → English.
 */
export function detectLang(preferred: readonly string[]): Lang {
  for (const raw of preferred) {
    const tag = raw.toLowerCase()
    if (tag === 'zh' || tag.startsWith('zh-')) return /(^|-)(hant|tw|hk|mo)(-|$)/.test(tag) ? 'zh-Hant' : 'zh-Hans'
    if (tag === 'en' || tag.startsWith('en-')) return 'en'
  }
  return 'en'
}

export function resolveLang(setting: LanguageSetting, preferred: readonly string[]): Lang {
  return setting === 'auto' ? detectLang(preferred) : setting
}
