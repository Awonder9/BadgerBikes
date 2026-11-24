// "Just ride": a ride with no destination. The rider picks how long and whether to end back at the start dock or at
// another dock; the ride follows bike trails past scenic places (src/routing/loop.ts, rideStore.loadLoopRoute).
import { useShallow } from 'zustand/react/shallow'
import { LOOP } from '../../config'
import { useI18n } from '../../i18n/useT'
import { routeChoiceLocked, useRideStore } from '../../ride/rideStore'
import { useTripStore } from '../../ride/tripStore'
import type { Highlight } from '../../routing/scenic'
import { Icon } from '../primitives/Icon'
import { useIncludedMinutes } from './useRidePlan'

/** The default length: the pass's included time when it is one of the choices (a free ride), else LOOP.defaultMinutes. */
function useDefaultMinutes(): number {
  const included = useIncludedMinutes()
  const choices: readonly number[] = LOOP.minuteChoices
  if (included !== null && choices.includes(included)) return included
  // A pass with an odd included time: the longest choice that still fits in it.
  const fits = included !== null ? choices.filter((m) => m <= included).at(-1) : undefined
  return fits ?? LOOP.defaultMinutes
}

/** Under "Where to?" when there is no destination yet: one tap plans a ride of the default length back to the start. */
export function JustRideButton() {
  const minutes = useDefaultMinutes()
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={() => {
        // A ride with no destination isn't one of a multi-stop trip's legs.
        useTripStore.getState().clear()
        useRideStore.getState().startLoop({ minutes, roundTrip: true })
      }}
      className="flex min-h-14 w-full items-center gap-3 rounded-xl bg-emerald-50 px-3 py-2 text-left ring-1 ring-emerald-600/40 dark:bg-emerald-950 dark:ring-emerald-400/40"
    >
      <Icon name="loop" size={22} className="shrink-0 text-emerald-700 dark:text-emerald-300" />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-emerald-900 dark:text-emerald-100">{t.justRide.button}</span>
        <span className="block text-sm text-emerald-800/80 dark:text-emerald-200/80">{t.justRide.buttonHelp}</span>
      </span>
    </button>
  )
}

/** Replaces the destination search while "Just ride" is on: its length, where it ends, and what it passes. */
export function JustRideCard() {
  const { loop, startId, status, locked } = useRideStore(useShallow((s) => ({ loop: s.loop, startId: s.startId, status: s.status, locked: routeChoiceLocked(s) })))
  const included = useIncludedMinutes()
  const { t } = useI18n()
  if (!loop) return null
  const set = (patch: Partial<{ minutes: number; roundTrip: boolean }>) => useRideStore.getState().startLoop({ minutes: loop.minutes, roundTrip: loop.roundTrip, ...patch })
  const chip = (on: boolean) =>
    `min-h-11 rounded-full px-3 text-sm font-medium ring-1 disabled:opacity-60 ${on ? 'bg-emerald-700 text-white ring-emerald-700' : 'bg-white ring-slate-300 dark:bg-slate-900 dark:ring-slate-600'}`
  return (
    <section aria-label={t.justRide.title} className="space-y-3 rounded-xl bg-emerald-50 p-3 dark:bg-emerald-950">
      <div className="flex items-center gap-2">
        <Icon name="loop" size={20} className="shrink-0 text-emerald-700 dark:text-emerald-300" />
        <p className="flex-1 font-semibold">{t.justRide.title}</p>
        {!locked && (
          <button type="button" className="min-h-11 px-2 text-sm font-medium text-brand-700 underline dark:text-brand-300" onClick={() => useRideStore.getState().setDestination(null)}>
            {t.justRide.pickDestination}
          </button>
        )}
      </div>

      <fieldset disabled={locked} className="space-y-1">
        <legend className="text-sm font-medium text-slate-600 dark:text-slate-300">{t.justRide.howLong}</legend>
        <div className="flex flex-wrap gap-2">
          {LOOP.minuteChoices.map((m) => (
            <button key={m} type="button" aria-pressed={loop.minutes === m} className={chip(loop.minutes === m)} onClick={() => loop.minutes !== m && set({ minutes: m })}>
              {t.minutes(m)}
            </button>
          ))}
        </div>
        {included !== null && <p className="text-xs text-slate-600 dark:text-slate-300">{t.justRide.passNote(included)}</p>}
      </fieldset>

      <fieldset disabled={locked} className="space-y-1">
        <legend className="text-sm font-medium text-slate-600 dark:text-slate-300">{t.justRide.endWhere}</legend>
        <div role="radiogroup" aria-label={t.justRide.endWhere} className="grid grid-cols-2 gap-1 rounded-xl bg-white p-1 ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-600">
          {[true, false].map((back) => (
            <button
              key={String(back)}
              type="button"
              role="radio"
              aria-checked={loop.roundTrip === back}
              onClick={() => loop.roundTrip !== back && set({ roundTrip: back })}
              className={`min-h-11 rounded-lg px-2 text-sm font-semibold disabled:opacity-60 ${loop.roundTrip === back ? 'bg-emerald-700 text-white' : 'text-slate-700 dark:text-slate-200'}`}
            >
              {back ? t.justRide.backToStart : t.justRide.anotherDock}
            </button>
          ))}
        </div>
      </fieldset>

      {!startId && <p className="text-sm text-slate-700 dark:text-slate-200">{t.justRide.needStart}</p>}
      {status === 'ready' && <Highlights loop={loop} />}
      {status === 'ready' && !locked && (
        <button
          type="button"
          onClick={() => useRideStore.getState().shuffleLoop()}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-white px-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-700 dark:bg-slate-900 dark:text-emerald-200"
        >
          <Icon name="refresh" size={18} /> {t.justRide.tryAnother}
        </button>
      )}
    </section>
  )
}

function Highlights({ loop }: { loop: { highlights: Highlight[]; fellBack: boolean } }) {
  const { t } = useI18n()
  const icon = { trail: 'bike', park: 'pin', water: 'pin', viewpoint: 'eye' } as const
  return (
    <div className="space-y-1">
      {loop.fellBack && <p className="text-sm text-amber-800 dark:text-amber-300">{t.justRide.fellBack}</p>}
      {loop.highlights.length > 0 ? (
        <>
          <p className="text-sm font-medium text-slate-600 dark:text-slate-300">{t.justRide.alongTheWay}</p>
          <ul className="flex flex-wrap gap-1.5">
            {loop.highlights.map((h) => (
              <li key={`${h.kind}|${h.name}`} className="flex max-w-full items-center gap-1 rounded-full bg-white px-2.5 py-1 text-sm ring-1 ring-emerald-600/30 dark:bg-slate-900">
                <Icon name={icon[h.kind]} size={14} className="shrink-0 text-emerald-700 dark:text-emerald-300" />
                <span className="truncate">{t.justRide.highlight(h.kind, h.name)}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-slate-500">{t.justRide.osmCredit}</p>
        </>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-300">{t.justRide.noHighlights}</p>
      )}
    </div>
  )
}
