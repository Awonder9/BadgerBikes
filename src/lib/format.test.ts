import { describe, expect, it } from 'vitest'
import { bikeMix, formatClockTime, formatDistance, formatDuration, formatTimeAgo, pluralize } from './format'

describe('formatDistance', () => {
  it('formats imperial', () => {
    expect(formatDistance(0, 'imperial')).toBe('10 ft')
    expect(formatDistance(30, 'imperial')).toBe('100 ft')
    expect(formatDistance(145, 'imperial')).toBe('480 ft') // 476 ft → nearest 10
    expect(formatDistance(158, 'imperial')).toBe('500 ft') // 518 ft → nearest 50
    expect(formatDistance(170, 'imperial')).toBe('0.1 mi') // ≥ 0.1 mi switches to miles
    expect(formatDistance(1609.344, 'imperial')).toBe('1.0 mi')
    expect(formatDistance(20_000, 'imperial')).toBe('12 mi')
  })

  it('formats metric', () => {
    expect(formatDistance(42, 'metric')).toBe('40 m')
    expect(formatDistance(347, 'metric')).toBe('350 m')
    expect(formatDistance(1234, 'metric')).toBe('1.2 km')
    expect(formatDistance(15_400, 'metric')).toBe('15 km')
  })
})

describe('formatDuration / formatTimeAgo / pluralize', () => {
  it('formats durations', () => {
    expect(formatDuration(10)).toBe('<1 min')
    expect(formatDuration(45)).toBe('1 min')
    expect(formatDuration(12 * 60 + 20)).toBe('12 min')
    expect(formatDuration(65 * 60)).toBe('1 h 5 min')
    expect(formatDuration(120 * 60)).toBe('2 h')
  })

  it('formats relative times', () => {
    expect(formatTimeAgo(3)).toBe('just now')
    expect(formatTimeAgo(25)).toBe('25 s ago')
    expect(formatTimeAgo(200)).toBe('3 min ago')
    expect(formatTimeAgo(7300)).toBe('2 h ago')
  })

  it('formats clock times in a given zone', () => {
    // 2026-11-17T21:45:00Z = 3:45 PM in Chicago.
    expect(formatClockTime(Date.UTC(2026, 10, 17, 21, 45), 'America/Chicago')).toBe('3:45 PM')
    expect(formatClockTime(Date.UTC(2026, 10, 17, 21, 45), 'Not/AZone')).toMatch(/\d{1,2}:45/)
  })

  it('pluralizes', () => {
    expect(pluralize(1, 'bike')).toBe('1 bike')
    expect(pluralize(0, 'dock')).toBe('0 docks')
  })
})

describe('bikeMix', () => {
  it('describes the bike types at a dock', () => {
    expect(bikeMix(3, 5)).toBe('3 e-bikes · 5 classic')
    expect(bikeMix(1, 0)).toBe('1 e-bike')
    expect(bikeMix(0, 2)).toBe('2 classic')
  })
})
