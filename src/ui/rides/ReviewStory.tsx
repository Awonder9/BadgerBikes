// A period's review as full-screen story cards ("your year in rides"): tap the right side for the next card, the left
// for the one before; cards advance on their own (HISTORY.storyCardMs) unless held. Cards without data are skipped.
// Everything shown comes from the rides on this device (src/history/review.ts).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { HISTORY } from '../../config'
import { useHistoryStore } from '../../history/historyStore'
import { buildReview, type Period, type Review } from '../../history/review'
import { useI18n } from '../../i18n/useT'
import { formatDistance, formatDuration } from '../../lib/format'
import { useAppStore } from '../../store/appStore'
import { Icon } from '../primitives/Icon'
import { shareText } from '../../native/share'
import { openOverlay } from '../layout/backButton'
import { isNativeApp } from '../platform'
import { deviceTimeZone, monthInitial, periodLabel, weekdayName } from './labels'

interface Card {
  key: string
  bg: string
  body: ReactNode
}

export function ReviewStory({ period, onClose }: { period: Period; onClose: () => void }) {
  const rides = useHistoryStore((s) => s.rides)
  const units = useAppStore((s) => s.settings.units)
  const { t, lang } = useI18n()
  const review = useMemo(() => buildReview(rides, period, deviceTimeZone()), [rides, period])
  const cards = useMemo(() => storyCards(review, units, lang, t), [review, units, lang, t])
  const [i, setI] = useState(0)
  const [held, setHeld] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  /** When the current press began: a long press only pauses the story. */
  const downAt = useRef(0)
  const last = cards.length - 1

  // Focus moves into the story, and back to where it was (the Play button) when it closes.
  useEffect(() => {
    const before = document.activeElement
    closeRef.current?.focus()
    return () => {
      if (before instanceof HTMLElement) before.focus()
    }
  }, [])
  // Android's back button closes the story first, not the panel under it.
  useEffect(() => openOverlay(onClose), [onClose])
  useEffect(() => {
    if (held || i >= last) return
    const id = setTimeout(() => setI((n) => Math.min(last, n + 1)), HISTORY.storyCardMs)
    return () => clearTimeout(id)
  }, [i, held, last])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') setI((n) => Math.min(last, n + 1))
      if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [last, onClose])

  // The cards can change under an open story (a ride recorded meanwhile): never past the last.
  const card = cards[Math.min(i, last)]!
  // On the page itself, not inside the panel: the panel's stacking context would leave the ride and offline banners
  // and notices (drawn above the panel) on top of this full-screen story.
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={t.review.title(periodLabel(period, lang, t))} className={`fixed inset-0 z-50 flex flex-col text-white transition-colors duration-500 ${card.bg}`}>
      <div className="flex gap-1 px-3 pt-[calc(0.75rem+env(safe-area-inset-top))]" aria-hidden>
        {cards.map((c, n) => (
          <span key={c.key} className="h-1 flex-1 overflow-hidden rounded-full bg-white/30">
            <span className={`block h-full bg-white ${n < i ? 'w-full' : n === i && !held && i < last ? 'story-progress' : n === i && i === last ? 'w-full' : 'w-0'}`} style={n === i ? { animationDuration: `${HISTORY.storyCardMs}ms` } : undefined} />
          </span>
        ))}
      </div>
      <div className="flex items-center justify-between px-3 pt-2">
        <p className="text-sm font-semibold text-white/90">{periodLabel(period, lang, t)}</p>
        <button ref={closeRef} type="button" aria-label={t.close} onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-full">
          <Icon name="close" size={24} />
        </button>
      </div>
      <div
        className="relative flex flex-1 select-none flex-col items-center justify-center px-8 pb-[calc(2rem+env(safe-area-inset-bottom))] text-center"
        onPointerDown={() => {
          downAt.current = Date.now()
          setHeld(true)
        }}
        onPointerUp={(e) => {
          setHeld(false)
          // Holding paused the story; letting go resumes it on the same card. A tap steps back or forward.
          if (Date.now() - downAt.current > HISTORY.storyTapMaxMs) return
          const r = e.currentTarget.getBoundingClientRect()
          setI((n) => (e.clientX - r.left < r.width / 3 ? Math.max(0, n - 1) : Math.min(last, n + 1)))
        }}
        onPointerCancel={() => setHeld(false)}
      >
        <div key={card.key} className="story-card w-full max-w-md space-y-4" aria-live="polite">
          {card.body}
        </div>
      </div>
      {i === last && (
        <div className="flex justify-center gap-2 px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
          <ShareReview review={review} units={units} />
          <button type="button" onClick={() => setI(0)} className="flex min-h-12 items-center gap-2 rounded-full bg-white/20 px-5 font-semibold">
            <Icon name="refresh" size={18} /> {t.review.replay}
          </button>
        </div>
      )}
    </div>,
    document.body,
  )
}

const Big = ({ children }: { children: ReactNode }) => <p className="text-6xl font-black leading-none tracking-tight">{children}</p>
const Line = ({ children }: { children: ReactNode }) => <p className="text-xl font-semibold leading-snug">{children}</p>
const Small = ({ children }: { children: ReactNode }) => <p className="text-base text-white/85">{children}</p>

/** Rides per day (week, month) or month (year): a little bar chart. */
function Bars({ buckets, labels }: { buckets: number[]; labels?: string[] }) {
  const max = Math.max(1, ...buckets)
  return (
    <div className="mx-auto flex h-24 w-full max-w-xs items-end gap-[3px]" aria-hidden>
      {buckets.map((b, n) => (
        <div key={n} className="flex flex-1 flex-col items-center gap-1">
          <div className="w-full rounded-t bg-white/90" style={{ height: `${Math.max(b ? 8 : 2, (b / max) * 80)}px`, opacity: b ? 1 : 0.35 }} />
          {labels && <span className="text-[10px] text-white/70">{labels[n]}</span>}
        </div>
      ))}
    </div>
  )
}

type T = ReturnType<typeof useI18n>['t']

function storyCards(r: Review, units: 'imperial' | 'metric', lang: ReturnType<typeof useI18n>['lang'], t: T): Card[] {
  const dist = (m: number) => formatDistance(m, units, lang)
  const label = t.rides.periodKind[r.period.kind]
  const cards: Card[] = [
    {
      key: 'intro',
      bg: 'bg-gradient-to-br from-brand-700 via-brand-800 to-slate-900',
      body: (
        <>
          <Icon name="sparkle" size={48} className="mx-auto" />
          <Line>{t.review.intro(label)}</Line>
          <Small>{t.review.introSub}</Small>
        </>
      ),
    },
    {
      key: 'totals',
      bg: 'bg-gradient-to-br from-emerald-600 to-teal-800',
      body: (
        <>
          <Small>{t.review.youRode}</Small>
          <Big>{dist(r.meters)}</Big>
          <Line>{t.review.ridesAndTime(r.rides, formatDuration(r.seconds, lang))}</Line>
          <Bars buckets={r.buckets} labels={r.period.kind === 'year' ? r.buckets.map((_, m) => monthInitial(m, lang)) : undefined} />
          {r.vsPrevious !== null && Math.abs(r.vsPrevious) >= 0.05 && <Small>{t.review.vsPrevious(Math.round(r.vsPrevious * 100), label)}</Small>}
        </>
      ),
    },
  ]
  if (r.topStart)
    cards.push({
      key: 'docks',
      bg: 'bg-gradient-to-br from-indigo-600 to-violet-900',
      body: (
        <>
          <Small>{t.review.favoriteDock}</Small>
          <Line>{r.topStart.name}</Line>
          <Small>{t.review.timesFrom(r.topStart.count)}</Small>
          {r.topRoute && <Small>{t.review.topRoute(r.topRoute.from, r.topRoute.to, r.topRoute.count)}</Small>}
          {r.docks > 2 && <Small>{t.review.docksVisited(r.docks)}</Small>}
        </>
      ),
    })
  if (r.trailShare !== null)
    cards.push({
      key: 'trails',
      bg: 'bg-gradient-to-br from-lime-600 to-green-900',
      body: (
        <>
          <Small>{t.review.onTrails}</Small>
          <Big>{Math.round(r.trailShare * 100)}%</Big>
          <Line>{t.review.trailDistance(dist(r.trailMeters))}</Line>
          {r.climbM >= 10 && <Small>{t.review.climbed(units === 'imperial' ? `${Math.round(r.climbM * 3.28084).toLocaleString(lang)} ft` : `${Math.round(r.climbM).toLocaleString(lang)} m`)}</Small>}
        </>
      ),
    })
  if (r.longest)
    cards.push({
      key: 'longest',
      bg: 'bg-gradient-to-br from-orange-500 to-rose-800',
      body: (
        <>
          <Small>{t.review.longest}</Small>
          <Big>{dist(r.longest.meters)}</Big>
          <Line>{r.longest.kind === 'loop' ? t.rides.loopFrom(r.longest.startName) : t.rides.fromTo(r.longest.startName, r.longest.endName)}</Line>
        </>
      ),
    })
  if (r.timeOfDay && r.busiestWeekday !== null)
    cards.push({
      key: 'habits',
      bg: 'bg-gradient-to-br from-sky-600 to-blue-900',
      body: (
        <>
          <Small>{t.review.habits}</Small>
          <Line>{t.review.timeOfDay[r.timeOfDay]}</Line>
          <Small>{t.review.busiestDay(weekdayName(r.busiestWeekday, lang))}</Small>
          {r.longestStreak >= 2 && <Small>{t.review.streak(r.longestStreak)}</Small>}
        </>
      ),
    })
  if (r.loops > 0)
    cards.push({
      key: 'loops',
      bg: 'bg-gradient-to-br from-teal-500 to-cyan-900',
      body: (
        <>
          <Icon name="loop" size={40} className="mx-auto" />
          <Line>{t.review.loops(r.loops)}</Line>
          {r.places.length > 0 && <Small>{t.review.places(r.places.map((p) => p.name).join(' · '))}</Small>}
        </>
      ),
    })
  cards.push(
    {
      key: 'impact',
      bg: 'bg-gradient-to-br from-green-600 to-emerald-950',
      body: (
        <>
          <Small>{t.review.impact}</Small>
          <Big>{t.review.co2(r.co2Kg < 10 ? r.co2Kg.toFixed(1) : Math.round(r.co2Kg).toLocaleString(lang))}</Big>
          <Line>{t.review.kcal(Math.round(r.kcal).toLocaleString(lang))}</Line>
          <p className="text-xs text-white/70">{t.review.estimates}</p>
        </>
      ),
    },
    {
      key: 'persona',
      bg: 'bg-gradient-to-br from-fuchsia-600 via-purple-700 to-indigo-900',
      body: (
        <>
          <Small>{t.review.youAre(label)}</Small>
          <p className="text-5xl font-black leading-tight">{t.review.persona[r.persona].name}</p>
          <Line>{t.review.persona[r.persona].why}</Line>
        </>
      ),
    },
  )
  return cards
}

function ShareReview({ review, units }: { review: Review; units: 'imperial' | 'metric' }) {
  const { t, lang } = useI18n()
  const [copied, setCopied] = useState(false)
  const text = t.review.shareText(t.rides.periodKind[review.period.kind], review.rides, formatDistance(review.meters, units, lang), t.review.persona[review.persona].name)
  const share = async () => {
    try {
      if (typeof navigator.share === 'function') return await navigator.share({ text })
      if (isNativeApp()) return void (await shareText(t.review.title(t.rides.periodKind[review.period.kind]), text))
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
    }
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      /* nothing to fall back to */
    }
  }
  return (
    <button type="button" onClick={() => void share()} className="flex min-h-12 items-center gap-2 rounded-full bg-white px-5 font-semibold text-slate-900">
      <Icon name="share" size={18} /> {copied ? t.copied : t.share}
    </button>
  )
}
