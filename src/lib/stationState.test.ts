
import { describe, expect, it } from 'vitest'
import { makeStation } from '../test/factories'
import { canRent, canReturn, classifyCount, classifyStation, fleetComposition, stateForMode } from './stationState'

describe('classifyCount', () => {
  it('uses absolute thresholds, raised by party size', () => {
    expect(classifyCount(0)).toBe('none')
    expect(classifyCount(1)).toBe('low')
    expect(classifyCount(2)).toBe('low')
    expect(classifyCount(3)).toBe('ok')
    expect(classifyCount(3, 2)).toBe('low')
    expect(classifyCount(4, 2)).toBe('ok')
    expect(classifyCount(1, 2)).toBe('low')
  })
})

describe('classifyStation', () => {
  it('separates bike and dock states', () => {
    const s = makeStation({ bikes: 0, docks: 12 })
    expect(classifyStation(s)).toEqual({ bikeState: 'none', dockState: 'ok', ebikeState: 'none' })
    expect(stateForMode(s, 'bikes')).toBe('none')
    expect(stateForMode(s, 'docks')).toBe('ok')
  })

  it('marks not-renting / not-returning / uninstalled / missing status as unavailable', () => {
    const notRenting = makeStation({ bikes: 5, docks: 3, isRenting: false })
    expect(classifyStation(notRenting).bikeState).toBe('unavailable')
    expect(classifyStation(notRenting).dockState).toBe('ok')
    expect(canRent(notRenting)).toBe(false)
    expect(canReturn(notRenting)).toBe(true)

    const notReturning = makeStation({ bikes: 5, docks: 3, isReturning: false })
    expect(classifyStation(notReturning).dockState).toBe('unavailable')
    expect(canReturn(notReturning)).toBe(false)

    const uninstalled = makeStation({ bikes: 5, docks: 3, isInstalled: false })
    expect(classifyStation(uninstalled)).toMatchObject({ bikeState: 'unavailable', dockState: 'unavailable' })

    const noStatus = { ...makeStation({}), status: null }
    expect(classifyStation(noStatus)).toEqual({ bikeState: 'unavailable', dockState: 'unavailable', ebikeState: null })
  })

  it('reports a null e-bike state when the feed has no type breakdown', () => {
    const s = makeStation({ bikes: 4, ebikes: null, classic: null })
    expect(classifyStation(s).ebikeState).toBeNull()
  })

  it('checks party size for eligibility', () => {
    const s = makeStation({ bikes: 2, docks: 1 })
    expect(canRent(s, 2)).toBe(true)
    expect(canRent(s, 3)).toBe(false)
    expect(canReturn(s, 2)).toBe(false)
  })
})

describe('fleetComposition', () => {
  it('detects single-type and mixed fleets', () => {
    expect(fleetComposition([makeStation({ bikes: 3, ebikes: 3, classic: 0 })])).toBe('electric')
    expect(fleetComposition([makeStation({ bikes: 3, ebikes: 0, classic: 3 })])).toBe('classic')
    expect(fleetComposition([makeStation({ bikes: 3, ebikes: 1, classic: 2 })])).toBe('mixed')
    expect(fleetComposition([makeStation({ bikes: 3, ebikes: null, classic: null })])).toBe('unknown')
    expect(fleetComposition([])).toBe('unknown')
  })
})
