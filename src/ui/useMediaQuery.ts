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

/** The OS / browser asks for a dark theme. */
export function usePrefersDark(): boolean {
  return useMediaQuery('(prefers-color-scheme: dark)')
}

/** Whether `style` ('auto' follows the OS) means dark, given the OS preference. */
export const isDarkStyle = (style: 'auto' | 'light' | 'dark', prefersDark: boolean): boolean => style === 'dark' || (style === 'auto' && prefersDark)
