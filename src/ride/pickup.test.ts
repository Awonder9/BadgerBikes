import { describe, expect, it } from 'vitest'
import { destination as dest } from '../lib/geo'
import { MADISON, makeStation } from '../test/factories'
import { pickupOptions } from './pickup'

const O = MADISON.capitol
describe('pickupOptions', () => {
  it('prefers a dock in the direction of travel over a slightly closer one behind you', () => {
    const behind = makeStation({ id: 'behind', coord: dest(O, 150, 270), bikes: 8 })
    const ahead = makeStation({ id: 'ahead', coord: dest(O, 250, 90), bikes: 8 })
    const to = dest(O, 3000, 90)
    expect(pickupOptions(O, to, [behind, ahead]).map((p) => p.station.id)).toEqual(['ahead', 'behind'])
    // Without a destination, the closest wins.
    expect(pickupOptions(O, null, [behind, ahead])[0]!.station.id).toBe('behind')
  })

  it('skips docks without enough bikes and penalizes nearly empty ones', () => {
    const empty = makeStation({ id: 'empty', coord: dest(O, 50, 0), bikes: 0 })
    const low = makeStation({ id: 'low', coord: dest(O, 100, 0), bikes: 1 })
    const ok = makeStation({ id: 'ok', coord: dest(O, 160, 0), bikes: 6 })
    const ids = pickupOptions(O, null, [empty, low, ok]).map((p) => p.station.id)
    expect(ids).toEqual(['ok', 'low'])
    expect(pickupOptions(O, null, [low, ok], 2).map((p) => p.station.id)).toEqual(['ok'])
  })

  it('falls back to the nearest docks when none is within walking range', () => {
    const far = makeStation({ id: 'far', coord: dest(O, 5000, 0), bikes: 5 })
    const p = pickupOptions(O, null, [far])
    expect(p[0]).toMatchObject({ station: { id: 'far' } })
    expect(p[0]!.walkS).toBeGreaterThan(3000)
  })
})

describe('pickupOptions with "Prefer e-bikes"', () => {
  it('ranks a dock without enough e-bikes lower, but still offers it', () => {
    const classicOnly = makeStation({ id: 'classic', coord: dest(O, 100, 0), bikes: 6, ebikes: 0, classic: 6 })
    const withEbikes = makeStation({ id: 'ebikes', coord: dest(O, 400, 0), bikes: 6, ebikes: 3, classic: 3 })
    expect(pickupOptions(O, null, [classicOnly, withEbikes]).map((p) => p.station.id)).toEqual(['classic', 'ebikes'])
    expect(pickupOptions(O, null, [classicOnly, withEbikes], 1, 3, true, true).map((p) => p.station.id)).toEqual(['ebikes', 'classic'])
  })
})
