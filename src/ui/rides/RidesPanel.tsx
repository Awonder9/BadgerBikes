// "Your rides": the rides recorded on this device, their weekly / monthly / yearly reviews (ReviewStory), and sending
// a ride to Strava. Its own lazily loaded chunk, like the planner.
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { STRAVA } from '../../config'
import { useMeta } from '../../data/hooks'
import { useHistoryStore } from '../../history/historyStore'
import { buildReview, nextPeriod, periodContaining, previousPeriod, type Period, type PeriodKind } from '../../history/review'
import { rideSecondsOf, type RideRecord } from '../../history/rides'
import { defaultElapsedS, disconnectStrava, sendToStrava, stravaConnectUrl, useStravaStore } from '../../history/strava'
import { useI18n } from '../../i18n/useT'
import { LANG_TAGS } from '../../i18n/lang'
import { formatDistance, formatDuration } from '../../lib/format'
import { toAppError } from '../../lib/errors'
import { dayKey } from '../../lib/usage'
import { useAppStore } from '../../store/appStore'
import { IconButton } from '../primitives/Button'
import { Icon } from '../primitives/Icon'
import { Spinner } from '../primitives/Spinner'
import { shareOrigin } from '../platform'
import { ReviewStory } from './ReviewStory'
import { periodLabel, deviceTimeZone } from './labels'

export function RidesPanel() {
  const rides = useHistoryStore((s) => s.rides)
  const units = useAppStore((s) => s.settings.units)
  const { t } = useI18n()
  const [story, setStory] = useState<Period | null>(null)
  const finished = rides.filter((r) => r.endedAtMs !== null)
  return (
    <section aria-label={t.rides.title} className="space-y-4 p-4">
      <header className="flex items-center gap-1">
        <IconButton icon="back" label={t.back} variant="ghost" onClick={() => useAppStore.getState().setPanel('browse')} />
        <h2 className="flex-1 text-xl font-semibold">{t.rides.title}</h2>
      </header>
      <StravaNotice />
      <Reviews onPlay={setStory} />
      <StravaConnection />
      <div className="space-y-2">
        <p className="text-sm font-medium text-slate-500">{t.rides.history}</p>
        {finished.length === 0 ? <p className="text-sm text-slate-600 dark:text-slate-300">{t.rides.empty}</p> : <RideList rides={finished} units={units} />}
        <p className="text-xs text-slate-500">{t.rides.deviceOnly}</p>
      </div>
      {story && <ReviewStory period={story} onClose={() => setStory(null)} />}
    </section>
  )
}

/** The result of coming back from Strava's connect page, once. */
function StravaNotice() {
  const { notice } = useStravaStore(useShallow((s) => ({ notice: s.notice })))
  const { t } = useI18n()
  if (!notice) return null
  return (
    <p role="status" className={`flex items-start gap-2 rounded-xl p-3 text-sm ${notice === 'connected' ? 'bg-emerald-50 dark:bg-emerald-950' : 'bg-amber-50 dark:bg-amber-950'}`}>
      <span className="flex-1">{t.strava.connectResult[notice]}</span>
      <button type="button" aria-label={t.dismiss} className="min-h-6 shrink-0" onClick={() => useStravaStore.setState({ notice: null })}>
        <Icon name="close" size={16} />
      </button>
    </p>
  )
}

/** Week / month / year, a period to step through, its totals, and "Play" for the story. */
function Reviews({ onPlay }: { onPlay: (p: Period) => void }) {
  const rides = useHistoryStore((s) => s.rides)
  const units = useAppStore((s) => s.settings.units)
  const { t, lang } = useI18n()
  const tz = deviceTimeZone()
  const [kind, setKind] = useState<PeriodKind>('month')
  const [today] = useState(() => dayKey(Date.now(), tz))
  const [period, setPeriod] = useState<Period>(() => periodContaining('month', today))
  const review = useMemo(() => buildReview(rides, period, tz), [rides, period, tz])
  const isCurrent = period.last >= today
  const pick = (k: PeriodKind) => {
    setKind(k)
    setPeriod(periodContaining(k, today))
  }
  return (
    <section aria-label={t.rides.reviews} className="space-y-3 rounded-2xl bg-gradient-to-br from-brand-700 to-emerald-700 p-4 text-white">
      <div role="radiogroup" aria-label={t.rides.reviews} className="grid grid-cols-3 gap-1 rounded-xl bg-white/15 p-1">
        {(['week', 'month', 'year'] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => pick(k)} className={`min-h-10 rounded-lg text-sm font-semibold ${kind === k ? 'bg-white text-brand-800' : 'text-white'}`}>
            {t.rides.periodKind[k]}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" aria-label={t.rides.previous} onClick={() => setPeriod(previousPeriod(period))} className="flex min-h-11 min-w-11 items-center justify-center rounded-full">
          <Icon name="back" size={22} />
        </button>
        <p className="flex-1 text-center font-semibold">{periodLabel(period, lang, t)}</p>
        <button type="button" aria-label={t.rides.next} disabled={isCurrent} onClick={() => setPeriod(nextPeriod(period))} className="flex min-h-11 min-w-11 items-center justify-center rounded-full disabled:opacity-30">
          <Icon name="chevronRight" size={22} />
        </button>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-center">
        <div>
          <dt className="text-xs text-white/80">{t.rides.ridesLabel}</dt>
          <dd className="text-2xl font-bold">{review.rides}</dd>
        </div>
        <div>
          <dt className="text-xs text-white/80">{t.rides.distanceLabel}</dt>
          <dd className="text-2xl font-bold">{formatDistance(review.meters, units, lang)}</dd>
        </div>
        <div>
          <dt className="text-xs text-white/80">{t.rides.timeLabel}</dt>
          <dd className="text-2xl font-bold">{formatDuration(review.seconds, lang)}</dd>
        </div>
      </dl>
      <button
        type="button"
        disabled={review.rides === 0}
        onClick={() => {
          useHistoryStore.getState().markSeen(period.key)
          onPlay(period)
        }}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-white font-semibold text-brand-800 disabled:opacity-50"
      >
        <Icon name="sparkle" size={20} /> {review.rides === 0 ? t.rides.noRidesInPeriod : t.rides.playReview(t.rides.periodKind[period.kind])}
      </button>
    </section>
  )
}

function StravaConnection() {
  const clientId = useMeta()?.stravaClientId ?? null
  const auth = useStravaStore((s) => s.auth)
  const { t } = useI18n()
  if (!clientId) return null
  return (
    <section aria-label="Strava" className="flex items-center gap-3 rounded-xl p-3 ring-1 ring-slate-200 dark:ring-slate-800">
      <span className="min-w-0 flex-1 text-sm">
        <span className="block font-semibold">Strava</span>
        <span className="block text-slate-600 dark:text-slate-300">{auth ? t.strava.connectedAs(auth.athleteName) : t.strava.connectHelp}</span>
      </span>
      {auth ? (
        <button type="button" className="min-h-11 shrink-0 px-2 text-sm font-medium underline" onClick={() => void disconnectStrava()}>
          {t.strava.disconnect}
        </button>
      ) : (
        // Strava's brand guidelines: "Connect with Strava", in Strava orange, linking to its authorize page.
        <a
          href="#strava"
          onClick={(e) => {
            e.preventDefault()
            window.location.assign(stravaConnectUrl(clientId, shareOrigin()))
          }}
          className="flex min-h-11 shrink-0 items-center rounded-lg px-3 text-sm font-bold text-white"
          style={{ background: STRAVA.brandColor }}
        >
          {t.strava.connect}
        </a>
      )}
    </section>
  )
}

function RideList({ rides, units }: { rides: RideRecord[]; units: 'imperial' | 'metric' }) {
  const { lang } = useI18n()
  const [open, setOpen] = useState<string | null>(null)
  const day = new Intl.DateTimeFormat(LANG_TAGS[lang], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return (
    <ul className="divide-y divide-slate-200 rounded-xl ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-800">
      {rides.slice(0, 100).map((r) => (
        <li key={r.id}>
          <RideRow ride={r} when={day.format(r.startedAtMs)} units={units} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
        </li>
      ))}
    </ul>
  )
}

function RideRow({ ride, when, units, open, onToggle }: { ride: RideRecord; when: string; units: 'imperial' | 'metric'; open: boolean; onToggle: () => void }) {
  const { t, lang } = useI18n()
  const secs = rideSecondsOf(ride)
  return (
    <>
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left">
        <Icon name={ride.kind === 'loop' ? 'loop' : 'bike'} size={20} className="shrink-0 text-brand-700 dark:text-brand-300" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{ride.kind === 'loop' ? t.rides.loopFrom(ride.startName) : t.rides.fromTo(ride.startName, ride.endName)}</span>
          <span className="block text-sm text-slate-500">
            {when} · {formatDistance(ride.meters, units, lang)} · {ride.endEstimated ? '~' : ''}
            {formatDuration(secs, lang)}
          </span>
        </span>
        {ride.stravaActivityId && (
          <span className="shrink-0 text-xs font-bold" style={{ color: STRAVA.brandColor }}>
            Strava ✓
          </span>
        )}
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={18} className="shrink-0 text-slate-400" />
      </button>
      {open && <RideDetails ride={ride} units={units} />}
    </>
  )
}

function RideDetails({ ride, units }: { ride: RideRecord; units: 'imperial' | 'metric' }) {
  const { t, lang } = useI18n()
  const [minutes, setMinutes] = useState(() => Math.round(defaultElapsedS(ride) / 60))
  const fix = () => {
    const m = Math.min(12 * 60, Math.max(1, Math.round(minutes)))
    useHistoryStore.getState().update(ride.id, { endedAtMs: ride.startedAtMs + m * 60_000, endEstimated: false })
  }
  return (
    <div className="space-y-3 bg-slate-50 px-3 pb-3 pt-1 text-sm dark:bg-slate-900">
      {ride.destName && ride.kind === 'ride' && <p>{t.rides.goingTo(ride.destName)}</p>}
      {ride.highlights.length > 0 && <p>{t.rides.passed(ride.highlights.join(' · '))}</p>}
      {ride.climbM !== null && <p>{t.rides.climb(formatDistance(ride.climbM, units, lang))}</p>}
      <label className="flex flex-wrap items-center gap-2">
        <span>{ride.endEstimated ? t.rides.estimatedTime : t.rides.rideTime}</span>
        <input type="number" inputMode="numeric" min={1} max={720} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="min-h-11 w-20 rounded-lg bg-white px-2 ring-1 ring-slate-300 dark:bg-slate-950 dark:ring-slate-600" />
        <span>{t.rides.minutesWord}</span>
        {Math.round(rideSecondsOf(ride) / 60) !== minutes && (
          <button type="button" className="min-h-11 rounded-lg px-2 font-semibold text-brand-700 ring-1 ring-slate-300 dark:text-brand-300" onClick={fix}>
            {t.rides.saveTime}
          </button>
        )}
      </label>
      <SendToStrava ride={ride} />
      <button type="button" className="min-h-11 font-medium text-red-700 underline dark:text-red-400" onClick={() => useHistoryStore.getState().remove(ride.id)}>
        {t.rides.deleteRide}
      </button>
    </div>
  )
}

function SendToStrava({ ride }: { ride: RideRecord }) {
  const clientId = useMeta()?.stravaClientId ?? null
  const auth = useStravaStore((s) => s.auth)
  const { t, lang } = useI18n()
  const [name, setName] = useState(() => (ride.kind === 'loop' ? t.strava.loopName(ride.startName) : t.strava.rideName(ride.startName, ride.endName)))
  const [commute, setCommute] = useState(false)
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'sending' } | { kind: 'error'; message: string }>({ kind: 'idle' })
  if (!clientId) return null
  if (ride.stravaActivityId) {
    return (
      // Strava's guidelines: "View on Strava", bold, in Strava orange.
      <a href={`${STRAVA.activityUrl}${ride.stravaActivityId}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-bold underline" style={{ color: STRAVA.brandColor }}>
        {t.strava.view}
      </a>
    )
  }
  if (!auth) return <p className="text-slate-600 dark:text-slate-300">{t.strava.connectFirst}</p>
  if (!ride.line) return <p className="text-slate-600 dark:text-slate-300">{t.strava.noLine}</p>
  const send = async () => {
    setState({ kind: 'sending' })
    try {
      await sendToStrava(ride, { name: name.trim() || t.strava.rideName(ride.startName, ride.endName), description: '', elapsedS: defaultElapsedS(ride), commute, lang })
      setState({ kind: 'idle' })
    } catch (e) {
      const code = toAppError(e).code
      setState({ kind: 'error', message: code === 'unauthorized' ? t.strava.reconnect : code === 'timeout' ? t.strava.slow : code === 'rate_limited' ? t.strava.busy : t.strava.failed })
    }
  }
  return (
    <div className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-950 dark:ring-slate-800">
      <label className="block space-y-1">
        <span className="font-medium">{t.strava.activityName}</span>
        <input value={name} maxLength={STRAVA.maxNameLength} onChange={(e) => setName(e.target.value)} className="min-h-11 w-full rounded-lg bg-slate-50 px-2 ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-600" />
      </label>
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" className="h-5 w-5" checked={commute} onChange={(e) => setCommute(e.target.checked)} />
        {t.strava.commute}
      </label>
      <p className="text-xs text-slate-500">{t.strava.plannedNote}</p>
      {ride.endEstimated && <p className="text-xs text-amber-800 dark:text-amber-300">{t.strava.estimatedWarning}</p>}
      <button
        type="button"
        disabled={state.kind === 'sending'}
        onClick={() => void send()}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg font-bold text-white disabled:opacity-60"
        style={{ background: STRAVA.brandColor }}
      >
        {state.kind === 'sending' ? <Spinner /> : <Icon name="share" size={18} />} {state.kind === 'sending' ? t.strava.sending : t.strava.send}
      </button>
      {state.kind === 'error' && <p role="alert" className="text-red-700 dark:text-red-400">{state.message}</p>}
    </div>
  )
}
