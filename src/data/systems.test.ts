import { describe, expect, it } from 'vitest'
import { getSystem, nearestSystem, SYSTEM_IDS, SYSTEMS } from './systems'

describe('systems registry', () => {
  it('loads validated systems with finite geometry', () => {
    expect(SYSTEMS.length).toBeGreaterThan(10)
    for (const s of SYSTEMS) {
      expect(s.bbox.every(Number.isFinite)).toBe(true)
      expect(s.center.every(Number.isFinite)).toBe(true)
    }
    expect(SYSTEM_IDS.has('bcycle_madison')).toBe(true)
    expect(getSystem('bcycle_madison')?.timezone).toBe('America/Chicago')
    expect(getSystem('nope')).toBeNull()
    expect(getSystem(null)).toBeNull()
  })

  it('picks the city nearest an approximate location, and nothing far from every system', () => {
    expect(nearestSystem([-89.4012, 43.0731])?.id).toBe('bcycle_madison') // downtown Madison
    expect(nearestSystem([-89.2, 43.15])?.id).toBe('bcycle_madison') // suburbs: IP locations are coarse
    expect(nearestSystem([-75.1652, 39.9526])?.id).toBe('bcycle_indego') // Philadelphia
    expect(nearestSystem([-150, 61])).toBeNull()
  })
})
