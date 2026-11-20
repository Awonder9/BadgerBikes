// "Nearest open dock" — where can I return this bike right now? — and "Nearest bike" — where can I pick one
// up? From the rider's position: the closest dock with room (or bikes) for the party, shown on the matching
// map view with its card open (walking directions are one tap away).
import { useState } from 'react'
import { latestSnapshot } from '../../data/hooks'
import { currentMessages } from '../../i18n/useT'
import { useLocationStore, waitForFix } from '../../location/locationStore'
import { useMapApiGetter } from '../../map/mapApiContext'
import { nearestBike, nearestOpenDock } from '../../ride/rideProgress'
import { useAppStore } from '../../store/appStore'
import { countUse } from '../usage'

export type NearestKind = 'bike' | 'dock'

const FINDERS = {
  bike: { find: nearestBike, mapMode: 'bikes', event: 'nearest_bike', none: 'noBikesNow' },
  dock: { find: nearestOpenDock, mapMode: 'docks', event: 'nearest_dock', none: 'noOpenDocks' },
} as const

export function useNearestStation(kind: NearestKind): { find: () => void; finding: boolean; message: string | null } {
  const getMap = useMapApiGetter()
  const [finding, setFinding] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const find = () => {
    setMessage(null)
    setFinding(true)
    void waitForFix().then((here) => {
      setFinding(false)
      const t = currentMessages()
      if (!here) return setMessage(useLocationStore.getState().geoError === 'geo_denied' ? t.locationDenied : t.locationNotFound)
      const app = useAppStore.getState()
      const f = FINDERS[kind]
      const hit = f.find(latestSnapshot(app.systemId)?.stations ?? [], here, app.settings.partySize)
      if (!hit) return setMessage(t[f.none])
      countUse(f.event)
      app.setMapMode(f.mapMode)
      app.selectStation(hit.station.id)
      getMap()?.flyTo(hit.station.coord, { zoom: 16 })
    })
  }
  return { find, finding, message }
}

export const useNearestOpenDock = () => useNearestStation('dock')
