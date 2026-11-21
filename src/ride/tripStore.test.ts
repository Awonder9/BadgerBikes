import { beforeEach, describe, expect, it } from 'vitest'
import type { Place } from '../types'
import { useRideStore } from './rideStore'
import { reconcileTrip, restoreTrip, useTripStore } from './tripStore'

const place = (name: string, lon: number, stationId?: string): Place =>
  stationId ? { kind: 'station', name, coord: [lon, 43.07], stationId } : { kind: 'search', name, coord: [lon, 43.07] }
const home = place('Home', -89.38)
const union = place('Memorial Union', -89.4)
const arb = place('UW Arboretum Visitor Center', -89.42)
const dock = place('Capitol Square', -89.39, 'bcycle_madison_9')

const ride = () => useRideStore.getState()
const trip = () => useTripStore.getState()

beforeEach(() => {
  ride().reset()
  trip().clear()
  ride().setOrigin(home)
  ride().setDestination(union)
})

describe('multi-stop trips', () => {
  it('start from the planned destination: adding a stop makes it stop 1, without re-planning', () => {
    trip().addStop(arb)
    expect(trip().stops.map((s) => s.name)).toEqual(['Memorial Union', 'UW Arboretum Visitor Center'])
    expect(trip().leg).toBe(0)
    expect(ride().destination).toBe(union)
    expect(ride().origin).toBe(home)
  })

  it('needs a destination first, and ignores the same stop twice in a row', () => {
    ride().setDestination(null)
    trip().addStop(arb)
    expect(trip().stops).toEqual([])
    ride().setDestination(union)
    trip().addStop(union)
    expect(trip().stops).toEqual([])
  })

  it('plan each later leg from the previous stop, and come back to leg 1’s own start', () => {
    trip().addStop(arb)
    trip().addStop(dock)
    trip().goToLeg(1)
    expect(ride()).toMatchObject({ origin: union, startId: null, pickupPinned: false, destination: arb, status: 'idle' })
    trip().goToLeg(2)
    // A dock as the stop: the next leg starts right there.
    trip().addStop(home)
    trip().goToLeg(3)
    expect(ride()).toMatchObject({ origin: dock, startId: 'bcycle_madison_9', pickupPinned: true, destination: home })
    trip().goToLeg(0)
    expect(ride()).toMatchObject({ origin: home, destination: union })
  })

  it('take a destination typed in the planner as the stop of the leg on screen', () => {
    trip().addStop(arb)
    trip().goToLeg(1)
    ride().setDestination(dock)
    expect(trip().stops).toEqual([union, dock])
  })

  it('re-plan the leg on screen only when an edit changes its ends', () => {
    trip().addStop(arb)
    trip().addStop(dock)
    trip().goToLeg(1)
    useRideStore.setState({ status: 'ready', stopIds: ['x'] })
    trip().removeStop(2) // after this leg: untouched
    expect(ride()).toMatchObject({ status: 'ready', stopIds: ['x'], destination: arb })
    trip().addStop(dock)
    trip().moveStopUp(2) // dock now before arb: this leg becomes Union → dock
    expect(trip().stops).toEqual([union, dock, arb])
    expect(ride()).toMatchObject({ origin: union, destination: dock, status: 'idle', stopIds: [] })
  })

  it('removing the leg’s destination re-plans; down to one stop it is a plain ride from leg 1’s start', () => {
    trip().addStop(arb)
    trip().goToLeg(1)
    trip().removeStop(1)
    expect(trip().stops).toEqual([])
    expect(ride()).toMatchObject({ origin: home, destination: union })
  })

  it('end when the plan is cleared', () => {
    trip().addStop(arb)
    ride().reset()
    expect(trip().stops).toEqual([])
  })

  it('remember the finished leg, and show the next one when its plan wasn’t saved', () => {
    trip().addStop(arb)
    ride().finishPlan()
    expect(trip().finishedLeg).toBe(0)
    // Back from Google Maps: a finished plan isn't saved, so the ride store comes back empty.
    useRideStore.setState({ origin: null, startId: null, destination: null, finished: false })
    useTripStore.setState({ stops: [union, arb], leg: 0, finishedLeg: 0 })
    reconcileTrip()
    expect(trip().leg).toBe(1)
    expect(ride()).toMatchObject({ origin: union, destination: arb })
  })

  it('are dropped at launch when they don’t match the saved plan', () => {
    trip().addStop(arb)
    useRideStore.setState({ destination: dock })
    useTripStore.setState({ stops: [union, arb], leg: 0 })
    reconcileTrip()
    expect(trip().stops).toEqual([])
  })

  it('restore defensively from storage', () => {
    expect(restoreTrip({ stops: [union, arb], leg: 1, finishedLeg: 0, firstStart: { origin: home, startId: 'bad id!', pickupPinned: true } })).toEqual({
      stops: [union, arb],
      leg: 1,
      finishedLeg: 0,
      firstStart: { origin: home, startId: null, pickupPinned: true },
    })
    expect(restoreTrip({ stops: [union, arb], leg: 7 })).toMatchObject({ leg: 0, finishedLeg: -1, firstStart: null })
    expect(restoreTrip({ stops: [union] })).toEqual({})
    expect(restoreTrip({ stops: [union, { kind: 'search', name: 'x', coord: [999, 0] }] })).toEqual({})
    expect(restoreTrip('nope')).toEqual({})
  })
})

describe('editing a trip mid-ride', () => {
  it('keeps the ride under way when the leg on screen keeps its ends', () => {
    trip().addStop(arb)
    trip().addStop(dock)
    trip().goToLeg(2) // arb → dock
    useRideStore.setState({ status: 'ready', stopIds: ['x'], openedParts: [0], rideStartedAtMs: 1 })
    trip().removeStop(0) // Union goes: this leg is now leg 1, still arb → dock
    expect(trip().leg).toBe(1)
    expect(ride()).toMatchObject({ origin: arb, destination: dock, stopIds: ['x'], openedParts: [0], rideStartedAtMs: 1 })
  })
})

describe('finishing a leg', () => {
  const T0 = Date.now() - 10 * 60_000 // ten minutes into the ride
  beforeEach(() => {
    trip().addStop(arb)
    trip().addStop(dock)
    // Leg 1 under way: its link opened, the BCycle ride timer running.
    useRideStore.setState({ status: 'ready', startId: 'bcycle_madison_1', openedParts: [0], rideStartedAtMs: T0 })
  })

  it('stays saved, waiting for "is it done?", when another leg follows', () => {
    ride().finishPlan()
    expect(trip().finishedLeg).toBe(0)
    expect(ride()).toMatchObject({ finished: false, openedParts: [0], rideStartedAtMs: T0, destination: union })
  })

  it('docked: the leg leaves the trip, the timer stops, and the next leg picks up a bike near the stop', () => {
    ride().finishPlan()
    trip().completeLeg(true)
    expect(trip().stops).toEqual([arb, dock])
    expect(trip()).toMatchObject({ leg: 0, finishedLeg: -1 })
    expect(ride()).toMatchObject({ origin: union, startId: null, destination: arb, rideStartedAtMs: null, openedParts: [], continuingRide: false })
  })

  it('kept the bike: the next leg starts at the given dock and the same ride’s timer runs on', () => {
    ride().finishPlan()
    trip().completeLeg(false, place('Union South', -89.41, 'bcycle_madison_5'))
    expect(ride()).toMatchObject({ startId: 'bcycle_madison_5', pickupPinned: true, destination: arb, rideStartedAtMs: T0, continuingRide: true, openedParts: [] })
    // Re-routing, another route option, a new destination: still the same ride.
    useRideStore.setState({ status: 'routing' })
    ride().setDestination(place('Picnic Point', -89.43))
    expect(ride()).toMatchObject({ rideStartedAtMs: T0, continuingRide: true })
    // The leg's first link starts at a dock but isn't a new ride; a later re-dock is.
    ride().markPartOpened(0, true)
    expect(ride().rideStartedAtMs).toBe(T0)
    ride().markPartOpened(1, true)
    expect(ride().rideStartedAtMs).toBeGreaterThan(T0)
  })

  it('down to the last stop it is an ordinary ride, and ending the ride stops the carried timer', () => {
    trip().removeStop(2)
    ride().finishPlan()
    trip().completeLeg(false, place('Union South', -89.41, 'bcycle_madison_5'))
    expect(trip().stops).toEqual([])
    expect(ride()).toMatchObject({ destination: arb, rideStartedAtMs: T0, continuingRide: true })
    ride().endRide()
    expect(ride()).toMatchObject({ rideStartedAtMs: null, continuingRide: false })
  })

  it('keeps each finished leg\'s line for the map, even once the trip is down to an ordinary ride', () => {
    const leg1: [number, number][] = [[-89.38, 43.07], [-89.4, 43.07]]
    const leg2: [number, number][] = [[-89.4, 43.07], [-89.42, 43.07]]
    ride().finishPlan()
    trip().completeLeg(true, null, leg1)
    expect(ride().pastLegs).toEqual([leg1])
    ride().finishPlan()
    trip().completeLeg(true, null, leg2)
    expect(trip().stops).toEqual([]) // one stop left: an ordinary ride
    expect(ride().pastLegs).toEqual([leg1, leg2])
    ride().reset()
    expect(ride().pastLegs).toEqual([])
  })

  it('jumping to another leg drops the finished legs drawn so far', () => {
    ride().finishPlan()
    trip().completeLeg(true, null, [[-89.38, 43.07], [-89.4, 43.07]])
    trip().goToLeg(1)
    expect(ride().pastLegs).toEqual([])
  })

  it('the last leg finishes like a one-stop ride (not saved), and a leg planned again isn’t finished', () => {
    trip().goToLeg(2)
    ride().finishPlan()
    expect(ride().finished).toBe(true)
    trip().goToLeg(1)
    expect(trip().finishedLeg).toBeLessThan(1)
    trip().goToLeg(2)
    expect(trip().finishedLeg).toBeLessThan(2)
  })
})
