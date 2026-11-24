import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HISTORY } from '../../config'
import { useHistoryStore } from '../../history/historyStore'
import { periodContaining } from '../../history/review'
import type { RideRecord } from '../../history/rides'
import { initialAppState, useAppStore } from '../../store/appStore'
import { goBack } from '../layout/backButton'
import { ReviewStory } from './ReviewStory'

// Wednesday 2026-11-18, midday in every US time zone.
const WED = Date.UTC(2026, 10, 18, 18)
const ride = (id: string, startedAtMs: number): RideRecord => ({
  id,
  systemId: 'bcycle_madison',
  startedAtMs,
  endedAtMs: startedAtMs + 15 * 60_000,
  endEstimated: false,
  startName: 'Capitol',
  startStationId: 'cap',
  endName: 'Memorial Union',
  endStationId: 'mu',
  destName: 'Memorial Union',
  meters: 2_400,
  plannedS: 900,
  electric: false,
  kind: 'ride',
  line: null,
  pathM: {},
  climbM: null,
  highlights: [],
  stravaActivityId: null,
})

describe('a ride review’s story', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: WED + 3 * 86_400_000 })
    useAppStore.setState({ ...initialAppState })
    useHistoryStore.setState({ rides: [ride('b', WED + 3_600_000), ride('a', WED)], active: null, seenReviews: [] })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('covers the whole page, not just the panel it was opened from', () => {
    const { container } = render(<ReviewStory period={periodContaining('week', '2026-11-18')} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(container.contains(dialog)).toBe(false)
    expect(dialog.parentElement).toBe(document.body)
  })

  it('steps forward on a tap; a long press only pauses it, on the same card', () => {
    render(<ReviewStory period={periodContaining('week', '2026-11-18')} onClose={() => {}} />)
    const stage = screen.getByText('Tap to see how you rode.').closest('.story-card')!.parentElement!
    fireEvent.pointerDown(stage, { clientX: 300 })
    act(() => vi.advanceTimersByTime(HISTORY.storyTapMaxMs + 500))
    fireEvent.pointerUp(stage, { clientX: 300 })
    expect(screen.getByText('Tap to see how you rode.')).toBeInTheDocument()
    fireEvent.pointerDown(stage, { clientX: 300 })
    fireEvent.pointerUp(stage, { clientX: 300 })
    expect(screen.getByText('You rode')).toBeInTheDocument()
  })

  it('closes with Escape, and with Android’s back button before the panel under it', () => {
    const onClose = vi.fn<() => void>()
    useAppStore.getState().setPanel('rides')
    render(<ReviewStory period={periodContaining('week', '2026-11-18')} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(goBack(useAppStore.getState())).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().panel).toBe('rides')
  })
})
