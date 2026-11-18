// Entry points into the ride planner from anywhere in the UI.
import { useRideStore } from '../../ride/rideStore'
import { useAppStore } from '../../store/appStore'
import type { LngLat, Place } from '../../types'

function openRide() {
  const app = useAppStore.getState()
  app.setPanel('ride')
  // Grow a peeking sheet so the planner is visible, but never shrink one the rider made full.
  if (app.sheet === 'peek') app.setSheet('half')
}

/** A dock tapped on the map while planning: it becomes the start dock, or (once there is one) the destination. */
export function rideMapTap(stationId: string, name: string, coord: LngLat): void {
  const ride = useRideStore.getState()
  if (!ride.startId) ride.setStart(stationId)
  else if (stationId !== ride.startId) ride.setDestination({ kind: 'station', name, coord, stationId })
}

export function startRideAt(stationId: string): void {
  useRideStore.getState().setStart(stationId)
  openRide()
}

export function rideTo(destination: Place): void {
  useRideStore.getState().setDestination(destination)
  openRide()
}

export function planRide(): void {
  openRide()
}

/** Switch city from Settings: the current ride plan belongs to the old city's stations, so it is cleared. */
export function changeCity(systemId: string): void {
  const app = useAppStore.getState()
  if (systemId === app.systemId) return
  if (app.setSystem(systemId)) useRideStore.getState().reset()
}
