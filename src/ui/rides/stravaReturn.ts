// Coming back from Strava's "connect" page (its redirect to this site's front page with ?strava=callback&code=…): on
// the web at launch (App), inside the iOS/Android apps when the link opens them (useNativeApp). Opens "Your rides",
// where the outcome is shown once. A code is used once (iPhone can report the same link twice).
import { finishStravaConnect, parseStravaCallback, useStravaStore } from '../../history/strava'
import { useAppStore } from '../../store/appStore'

const handled = new Set<string>()

/** True when `search` is Strava's redirect (handled here; the caller removes it from the address bar). */
export function openStravaReturn(search: string): boolean {
  const cb = parseStravaCallback(search)
  if (!cb) return false
  const app = useAppStore.getState()
  app.setPanel('rides')
  if (app.sheet === 'peek') app.setSheet('half')
  const once = cb.code ?? cb.error ?? ''
  if (handled.has(once)) return true
  handled.add(once)
  void finishStravaConnect(cb).then((notice) => useStravaStore.setState({ notice }))
  return true
}
