// React side of i18n: the rider's language from Settings ('auto' = the system/browser language).
import { useAppStore } from '../store/appStore'
import { MESSAGES, resolveLang, type Lang, type Messages } from './index'

function systemLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : []
}

/** Current language outside React (notifications, places created in event handlers). */
export function currentLang(): Lang {
  return resolveLang(useAppStore.getState().settings.language, systemLanguages())
}

export function currentMessages(): Messages {
  return MESSAGES[currentLang()]
}

export function useLang(): Lang {
  const setting = useAppStore((s) => s.settings.language)
  return resolveLang(setting, systemLanguages())
}

/** UI text in the rider's language. */
export function useT(): Messages {
  return MESSAGES[useLang()]
}

/** Text plus the language code, for components that also format numbers, durations or distances. */
export function useI18n(): { t: Messages; lang: Lang } {
  const lang = useLang()
  return { t: MESSAGES[lang], lang }
}
