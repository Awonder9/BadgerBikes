// Last-resort leg: a straight line with estimated duration (provider 'straight').
import { haversine } from '../lib/geo'
import { estimateBetween } from './estimates'
import type { RouteLeg } from '../types'
import { instructionText } from './maneuvers'
import type { RouteRequest } from './types'

export function straightLeg(req: RouteRequest): RouteLeg {
  const { duration } = estimateBetween(req.from, req.to, req.mode, req.bikeKind)
  const distance = haversine(req.from, req.to)
  return {
    role: req.role,
    mode: req.mode,
    from: req.from,
    to: req.to,
    geometry: [req.from, req.to],
    snapFromM: 0,
    snapToM: 0,
    distance,
    duration,
    maneuvers: [
      { kind: 'depart', instruction: instructionText('depart', { isBike: req.mode === 'bike' }), distance, duration, location: req.from, beginIndex: 0, endIndex: 1 },
      { kind: 'arrive', instruction: instructionText('arrive'), distance: 0, duration: 0, location: req.to, beginIndex: 1, endIndex: 1 },
    ],
    provider: 'straight',
    units: req.units,
    language: req.language,
    ...(req.stationId ? { stationId: req.stationId } : {}),
  }
}
