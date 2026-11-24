// The home panel's way into "Your rides": a banner when a review is ready (last week's, last month's, or the year's in
// December and January), else a row once the device has rides. Kept small: the panel itself loads on demand.
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useHistoryStore } from '../../history/historyStore'
import { reviewToOffer } from '../../history/periods'
import { useI18n } from '../../i18n/useT'
import { useAppStore } from '../../store/appStore'
import { Icon } from '../primitives/Icon'
import { deviceTimeZone, periodLabel } from './labels'

const open = () => {
  const app = useAppStore.getState()
  app.setPanel('rides')
  if (app.sheet === 'peek') app.setSheet('half')
}

export function RidesEntry() {
  const { rides, seen } = useHistoryStore(useShallow((s) => ({ rides: s.rides, seen: s.seenReviews })))
  const { t, lang } = useI18n()
  // The day the panel opened is "today" (it doesn't tick: a review offer changes at most once a day).
  const [nowMs] = useState(() => Date.now())
  const offer = useMemo(() => reviewToOffer(rides, nowMs, deviceTimeZone(), seen), [rides, nowMs, seen])
  if (offer)
    return (
      <button type="button" onClick={open} className="flex min-h-14 w-full items-center gap-3 rounded-xl bg-gradient-to-r from-brand-700 to-emerald-600 px-3 py-2 text-left text-white shadow-sm">
        <Icon name="sparkle" size={24} className="shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">{t.rides.reviewReady(t.rides.periodKind[offer.kind])}</span>
          <span className="block truncate text-sm text-white/85">{periodLabel(offer, lang, t)}</span>
        </span>
        <Icon name="chevronRight" size={20} className="shrink-0" />
      </button>
    )
  if (!rides.some((r) => r.endedAtMs !== null)) return null
  return (
    <button type="button" onClick={open} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-2 text-left text-sm font-medium text-brand-700 hover:bg-slate-100 dark:text-brand-300 dark:hover:bg-slate-800">
      <Icon name="history" size={18} className="shrink-0" />
      <span className="flex-1">{t.rides.title}</span>
      <Icon name="chevronRight" size={18} className="shrink-0" />
    </button>
  )
}
