// "Nearest open dock" — where can I return this bike right now? From the rider's position: the closest dock
// with room for the party, shown on the docks map with its card open (walking directions are one tap away).
import { useState } from 'react'
import { latestSnapshot } from '../../data/hooks'
import { currentMessages } from '../../i18n/useT'
import { useLocationStore, waitForFix } from '../../location/locationStore'
import { useMapApiGetter } from '../../map/mapApiContext'
import { nearestOpenDock } from '../../ride/rideProgress'
import { useAppStore } from '../../store/appStore'

export function useNearestOpenDock(): { find: () => void; finding: boolean; message: string | null } {
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
      const hit = nearestOpenDock(latestSnapshot(app.systemId)?.stations ?? [], here, app.settings.partySize)
      if (!hit) return setMessage(t.noOpenDocks)
      app.setMapMode('docks')
      app.selectStation(hit.station.id)
      getMap()?.flyTo(hit.station.coord, { zoom: 16 })
    })
  }
  return { find, finding, message }
}
