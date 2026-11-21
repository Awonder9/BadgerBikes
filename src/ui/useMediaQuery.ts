// Subscribes a component to a CSS media query (e.g. the phone switching to dark mode at sunset).
import { useCallback, useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * The color scheme to use, given what the OS reports now (`matches`), whether the page is visible, and the value
 * in use (`last`, null at first). iOS flips a backgrounded app between light and dark to take its app-switcher
 * snapshots — and doesn't always report flipping back — so while the page is hidden the value in use is kept;
 * it is read afresh whenever the page is visible.
 */
export function colorSchemeSnapshot(matches: boolean, visible: boolean, last: boolean | null): boolean {
  return last === null || visible ? matches : last
}

let lastDark: boolean | null = null
const darkSnapshot = () => (lastDark = colorSchemeSnapshot(window.matchMedia(DARK_QUERY).matches, document.visibilityState === 'visible', lastDark))

/** Media query changes, plus every return to the page: a change made while it was hidden may never be reported. */
function subscribeDark(onChange: () => void): () => void {
  const mq = window.matchMedia(DARK_QUERY)
  mq.addEventListener('change', onChange)
  document.addEventListener('visibilitychange', onChange)
  window.addEventListener('pageshow', onChange)
  window.addEventListener('focus', onChange)
  return () => {
    mq.removeEventListener('change', onChange)
    document.removeEventListener('visibilitychange', onChange)
    window.removeEventListener('pageshow', onChange)
    window.removeEventListener('focus', onChange)
  }
}

/** The OS / browser asks for a dark theme. */
export function usePrefersDark(): boolean {
  return useSyncExternalStore(subscribeDark, darkSnapshot, () => false)
}

/** Whether `style` ('auto' follows the OS) means dark, given the OS preference. */
export const isDarkStyle = (style: 'auto' | 'light' | 'dark', prefersDark: boolean): boolean => style === 'dark' || (style === 'auto' && prefersDark)
