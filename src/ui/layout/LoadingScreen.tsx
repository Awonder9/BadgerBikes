// Launch screen: covers the app until the first live station snapshot arrives, so riders never act on
// counts that aren't current. If BCycle can't be reached it says so, with Retry / Continue.
import { useEffect, useState } from 'react'
import { APP } from '../../config'
import { useNow, useStationsSnapshot } from '../../data/hooks'
import { getSystem } from '../../data/systems'
import { useAppStore } from '../../store/appStore'
import { useI18n } from '../../i18n/useT'
import { Icon } from '../primitives/Icon'

/** After this long the screen adds a "still working" line. */
const SLOW_MS = 6_000
/** Fade-out duration (matches the transition class). */
const FADE_MS = 400

export function LoadingScreen() {
  const systemId = useAppStore((s) => s.systemId)
  const { snapshot, freshness, refetch } = useStationsSnapshot(systemId)
  const [shownAt] = useState(() => Date.now())
  const [dismissed, setDismissed] = useState(false)
  const [gone, setGone] = useState(false)
  const now = useNow(1000)
  const { t: msg } = useI18n()
  const loaded = !!snapshot
  const failed = !loaded && freshness === 'error'
  const hide = loaded || dismissed

  useEffect(() => {
    if (!hide) return
    const t = setTimeout(() => setGone(true), FADE_MS)
    return () => clearTimeout(t)
  }, [hide])
  if (gone) return null

  const city = getSystem(systemId)?.city ?? msg.yourCity
  const slow = now - shownAt > SLOW_MS
  return (
    <div
      className={`absolute inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-gradient-to-b from-brand-700 to-brand-900 px-8 text-center text-white transition-opacity duration-[400ms] ${hide ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
      aria-hidden={hide}
    >
      <div className="grid h-24 w-24 place-items-center rounded-full bg-white/10 ring-1 ring-white/20">
        <Icon name="bike" size={52} className={failed ? '' : 'motion-safe:animate-pulse'} />
      </div>
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">{APP.name}</h1>
        <p className="text-white/80">{city}</p>
      </div>

      {!failed ? (
        <div role="status" aria-live="polite" className="w-full max-w-xs space-y-3">
          <p className="text-lg font-medium">{msg.pullingCounts}</p>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/20" aria-hidden>
            <div className="h-full w-1/3 rounded-full bg-white motion-safe:animate-[loading-bar_1.2s_ease-in-out_infinite]" />
          </div>
          <p className={`text-sm text-white/75 transition-opacity ${slow ? 'opacity-100' : 'opacity-0'}`}>{msg.stillWorking}</p>
        </div>
      ) : (
        <div role="alert" className="w-full max-w-xs space-y-3">
          <p className="text-lg font-semibold">{msg.couldntReach}</p>
          <p className="text-sm text-white/80">{msg.checkConnection}</p>
          <div className="flex gap-2">
            <button type="button" className="min-h-12 flex-1 rounded-xl bg-white font-semibold text-brand-800" onClick={refetch}>
              {msg.tryAgain}
            </button>
            <button type="button" className="min-h-12 flex-1 rounded-xl font-semibold ring-1 ring-white/60" onClick={() => setDismissed(true)}>
              {msg.continue}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
