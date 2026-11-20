// Opening a share link (src/lib/urlParams.ts reads it): at launch from the address bar, or inside the iOS/Android
// apps whenever a link opens them (src/native/useNativeApp.ts).
import { currentMessages } from '../i18n/useT'
import type { LaunchParams } from '../lib/urlParams'
import { useRideStore } from '../ride/rideStore'
// Loaded at launch: the trip follows the plan from the start (a share link or a city change clears both).
import '../ride/tripStore'
import { useAppStore } from '../store/appStore'
import type { Place } from '../types'
import { changeCity } from './ride/rideActions'

export function openLaunchParams(p: LaunchParams): void {
  const app = useAppStore.getState()
  // Another city than the stored one: like Settings → City (a saved plan belongs to the old city's docks).
  if (p.systemId) changeCity(p.systemId)
  if (p.stationId) app.selectStation(p.stationId)
  // A shared ride: start dock + destination (+ route option). The planner routes it once stations load.
  if (p.rideStartId && p.to) {
    const ride = useRideStore.getState()
    const destination: Place = p.toStationId
      ? { kind: 'station', name: p.to.name ?? currentMessages().destinationDock, coord: p.to.coord, stationId: p.toStationId }
      : { kind: 'search', name: p.to.name ?? currentMessages().sharedDestination, coord: p.to.coord }
    // It replaces whatever was planned: no start place or ride progress carries over from an older plan.
    ride.reset()
    ride.setStart(p.rideStartId)
    ride.setDestination(destination)
    useRideStore.setState({ pendingRouteIndex: p.routeIndex })
    app.setPanel('ride')
    app.setSheet('half')
  }
}
