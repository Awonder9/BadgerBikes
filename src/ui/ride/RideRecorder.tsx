// Records rides into the history on this device (src/history): a record starts when a planned ride's timer starts,
// follows the plan while it is ridden (another end dock, the path details once loaded), and ends when the ride does.
// Mounted only while a ride is under way or one is still being recorded, so it costs nothing otherwise.
//
// How the end is known: the rider ends it in the app (End ride, arriving, the next leg of a trip) — that moment; or the
// plan is simply gone when the app is next opened (its last link was opened, so it wasn't kept) — then the route's
// riding time stands in, marked as estimated (the rider can correct it in the ride's details).
import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useRouteDetails } from '../../data/routeDetails'
import { useHistoryStore } from '../../history/historyStore'
import { recorderStep, type RecorderInput } from '../../history/recorder'
import { encodeLine } from '../../history/rides'
import { rideTrack } from '../../ride/gpx'
import { rideUnderWay, useRideStore } from '../../ride/rideStore'
import { useAppStore } from '../../store/appStore'
import { useRidePlan } from './useRidePlan'

export function RideRecorder() {
  const underWay = useRideStore(rideUnderWay)
  const { on, open } = useHistoryStore(useShallow((s) => ({ on: s.recording, open: s.active !== null })))
  // Turned off in "Your rides": nothing is recorded (turning it off dropped the record that was open).
  return on && (underWay || open) ? <Recorder /> : null
}

function Recorder() {
  const systemId = useAppStore((s) => s.systemId)
  const plan = useRidePlan()
  const r = useRideStore(
    useShallow((s) => ({
      underWay: rideUnderWay(s),
      startedAt: s.rideStartedAtMs,
      route: s.route,
      startId: s.startId,
      destination: s.destination,
      routeIndex: s.routeIndex,
      loop: s.loop,
      bikeAt: s.bikeAt,
      setOff: s.openedParts.length > 0 || (s.rideStartedAtMs !== null && !s.continuingRide),
    })),
  )
  // The path details the planner already loaded (React Query's cache), for "how much was on trails".
  const { details } = useRouteDetails(systemId, r.underWay ? r.route : null)
  // A ride seen under way in this page: when it stops, the rider ended it here (its end is now).
  const seenUnderWay = useRef(false)
  const { start, end, rideSeconds, electric } = plan

  useEffect(() => {
    const h = useHistoryStore.getState()
    const record = h.active ? h.rides.find((x) => x.id === h.active!.id) : undefined
    const active = record && h.active ? { record, planKey: h.active.planKey, ridden: h.active.ridden } : null
    if (r.underWay) seenUnderWay.current = true
    const ridden: RecorderInput['plan'] =
      r.route && start && end && systemId
        ? {
            key: `${systemId}|${r.startId}|${r.destination?.coord.join(',') ?? ''}|${r.routeIndex}|${r.loop?.seed ?? ''}`,
            fields: {
              systemId,
              startName: start.name,
              startStationId: start.id,
              endName: end.station.name,
              endStationId: end.station.id,
              destName: r.loop ? null : (r.destination?.name ?? null),
              meters: Math.round(end.along + end.offset),
              plannedS: Math.round(rideSeconds ?? r.route.duration),
              electric,
              kind: r.loop ? 'loop' : 'ride',
              line: encodeLine(rideTrack(r.route.geometry, { coord: end.station.coord, along: end.along })),
              pathM: Object.fromEntries((details?.breakdown ?? []).map((b) => [b.kind, Math.round(b.meters)])),
              climbM: details?.elevation ? Math.round(details.elevation.gainM) : null,
              highlights: (r.loop?.highlights ?? []).map((x) => x.name).filter(Boolean),
            },
          }
        : null
    const step = recorderStep(
      active,
      { underWay: r.underWay, startedAtMs: r.startedAt, plan: ridden, seenUnderWay: seenUnderWay.current, setOff: r.setOff },
      Date.now(),
      (at) => `${at.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    )
    if (step.kind === 'update') h.follow(step.id, step.fields, step.planKey, step.ridden)
    else if (step.kind === 'close') h.closeActive(step.end)
    else if (step.kind === 'start') {
      if (step.close !== 'none') h.closeActive(step.close)
      h.add(step.ride, step.planKey, step.ridden)
    }
  }, [r, start, end, rideSeconds, electric, details, systemId])

  return null
}
