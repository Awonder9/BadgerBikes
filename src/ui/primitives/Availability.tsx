// One consistent availability display for StationCard, search results, TripSummary and the HUD.
import type { AvailabilityState } from '../../types'
import { Icon } from './Icon'

const STATE_CLASSES: Record<AvailabilityState, string> = {
  ok: 'bg-avail-ok/10 text-avail-ok ring-avail-ok/40 dark:bg-avail-ok/25 dark:text-green-300',
  low: 'bg-avail-low/10 text-avail-low ring-avail-low/40 dark:bg-avail-low/25 dark:text-amber-300',
  none: 'bg-transparent text-avail-none ring-avail-none dark:text-red-300',
  unavailable: 'bg-slate-100 text-slate-500 ring-slate-300 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-600',
}

const STATE_WORD: Record<AvailabilityState, string> = { ok: '', low: 'low', none: 'none', unavailable: 'unavailable' }

export interface AvailabilityPillProps {
  kind: 'bikes' | 'docks'
  count: number
  state: AvailabilityState
  /** Show "⚡ n" for e-bikes (mixed fleets only; pass null to hide). */
  ebikes?: number | null
  size?: 'sm' | 'md' | 'lg'
}

/** "🚲 5" / "⚓ 3" pill; unavailable shows ✕ instead of a number. Screen readers get a full sentence. */
export function AvailabilityPill({ kind, count, state, ebikes = null, size = 'md' }: AvailabilityPillProps) {
  const text = size === 'lg' ? 'text-2xl px-3 py-1.5' : size === 'sm' ? 'text-sm px-2 py-0.5' : 'text-base px-2.5 py-1'
  const iconSize = size === 'lg' ? 26 : size === 'sm' ? 16 : 20
  const noun = kind === 'bikes' ? (count === 1 ? 'bike' : 'bikes') : count === 1 ? 'dock' : 'docks'
  const label =
    state === 'unavailable'
      ? `${kind === 'bikes' ? 'Bikes' : 'Docks'} unavailable`
      : `${count} ${noun}${ebikes !== null && kind === 'bikes' ? `, ${ebikes} electric` : ''}${STATE_WORD[state] ? ` (${STATE_WORD[state]})` : ''}`
  return (
    <span className={`inline-flex items-center rounded-full font-semibold tabular-nums ring-1 ${STATE_CLASSES[state]} ${text}`}>
      <span className="sr-only">{label}</span>
      <span aria-hidden className="inline-flex items-center gap-1">
        <Icon name={kind === 'bikes' ? 'bike' : 'dock'} size={iconSize} />
        {state === 'unavailable' ? '✕' : count}
        {ebikes !== null && kind === 'bikes' && state !== 'unavailable' && (
          <span className="inline-flex items-center gap-0.5 text-[0.8em] opacity-90">
            <Icon name="bolt" size={Math.round(iconSize * 0.7)} />
            {ebikes}
          </span>
        )}
      </span>
    </span>
  )
}
