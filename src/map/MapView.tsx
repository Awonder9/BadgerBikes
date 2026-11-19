// The single map (mounted once at the app root). The maplibre runtime is loaded on demand from ./maplibre
// (this file imports only its types): it is most of the app's JavaScript, so it downloads in parallel with
// the first station request instead of before it. Until it has loaded, the map API queues camera changes.
import type { GeoJSONSource, MapGeoJSONFeature, MapMouseEvent, Map as MlMap } from 'maplibre-gl'
import { useEffect, useEffectEvent, useImperativeHandle, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { MAP } from '../config'
import { getSystem } from '../data/systems'
import { useStationsSnapshot } from '../data/hooks'
import { AppError } from '../lib/errors'
import { fleetComposition } from '../lib/stationState'
import { useAppStore } from '../store/appStore'
import { useT } from '../i18n/useT'
import { useLocationStore } from '../location/locationStore'
import type { BBox, LngLat, MapMode } from '../types'
import { useRideStore } from '../ride/rideStore'
import { isDarkStyle, usePrefersDark } from '../ui/useMediaQuery'
import { useRidePlan } from '../ui/ride/useRidePlan'
import { AVAILABILITY_COLORS, PATH_COLORS, ROUTE_COLORS, STAR_GOLD, USER_PUCK } from './colors'
import { markMapSettled } from './mapSettled'
import { addSavedIcons, savedImageId } from './savedIcons'
import { useRouteDetails } from '../data/routeDetails'
import type { PathKind } from '../routing/details'
import { buildEndpointFeatures, buildSavedPlaceFeatures, buildPathKindFeatures, buildRouteFeatures, buildWalkFeatures, buildStationFeatures, buildUserFeatures, emptyCollection, rideRoles } from './features'
import { LAYER_IDS as L, SOURCE_IDS as S, type MapViewProps, type Padding, type StationFeatureProps } from './types'

// Starts downloading the map runtime as soon as the app starts. A failure is reported when the map is created.
const runtime = import('./maplibre')
runtime.catch(() => {})

const ATTRIBUTION = [
  'Routing: <a href="https://valhalla1.openstreetmap.de">Valhalla</a> &amp; OSRM by FOSSGIS',
  'Search: <a href="https://photon.komoot.io">Photon</a>',
  '<a href="https://www.openstreetmap.org/fixthemap">Report a map problem</a>',
]

/** What the station dots count: bikes, open docks, or — "Prefer e-bikes" in a mixed fleet — e-bikes only. */
type StationView = MapMode | 'ebikes'
const STATE_PROP: Record<StationView, keyof StationFeatureProps> = { bikes: 'bikeState', docks: 'dockState', ebikes: 'ebikeState' }

function colorExpr(view: StationView) {
  return ['match', ['get', STATE_PROP[view]], 'ok', AVAILABILITY_COLORS.ok, 'low', AVAILABILITY_COLORS.low, 'none', '#ffffff', AVAILABILITY_COLORS.unavailable] as never
}
function strokeExpr(view: StationView) {
  return ['match', ['get', STATE_PROP[view]], 'none', AVAILABILITY_COLORS.none, '#ffffff'] as never
}
function labelExpr(view: StationView) {
  // A station without a bike-type breakdown (ebikes −1) shows its total.
  const count = view === 'ebikes' ? ['case', ['<', ['get', 'ebikes'], 0], ['get', 'bikes'], ['get', 'ebikes']] : ['get', view]
  return ['case', ['==', ['get', STATE_PROP[view]], 'unavailable'], '✕', ['to-string', count]] as never
}
function labelColorExpr(view: StationView) {
  return ['match', ['get', STATE_PROP[view]], 'none', AVAILABILITY_COLORS.none, '#ffffff'] as never
}

function pathColorExpr(dark: boolean) {
  const entries = (Object.entries(PATH_COLORS) as Array<[PathKind, string]>).flatMap(([k, c]) => [k, dark && k === 'quietStreet' ? '#94a3b8' : c])
  return ['match', ['get', 'kind'], ...entries, '#0f766e'] as never
}

function ensureLayers(map: MlMap, view: StationView, dark: boolean) {
  const rc = dark ? ROUTE_COLORS.dark : ROUTE_COLORS.light
  if (!map.getSource(S.route)) map.addSource(S.route, { type: 'geojson', data: emptyCollection() })
  if (!map.getSource(S.stations)) map.addSource(S.stations, { type: 'geojson', data: emptyCollection(), promoteId: 'id' })
  if (!map.getSource(S.routeKinds)) map.addSource(S.routeKinds, { type: 'geojson', data: emptyCollection() })
  if (!map.getSource(S.endpoints)) map.addSource(S.endpoints, { type: 'geojson', data: emptyCollection() })
  if (!map.getSource(S.user)) map.addSource(S.user, { type: 'geojson', data: emptyCollection() })
  if (!map.getSource(S.saved)) map.addSource(S.saved, { type: 'geojson', data: emptyCollection() })
  addSavedIcons(map)
  if (!map.getLayer(L.routeWalk))
    map.addLayer({ id: L.routeWalk, type: 'line', source: S.route, filter: ['==', ['get', 'mode'], 'walk'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': rc.walk, 'line-width': 4, 'line-dasharray': [0.1, 2], 'line-opacity': ['case', ['==', ['get', 'done'], 1], 0.35, 1] } })
  if (!map.getLayer(L.routeBikeCasing))
    map.addLayer({ id: L.routeBikeCasing, type: 'line', source: S.route, filter: ['==', ['get', 'mode'], 'bike'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': rc.bikeCasing, 'line-width': 9 } })
  if (!map.getLayer(L.routeBike))
    map.addLayer({ id: L.routeBike, type: 'line', source: S.route, filter: ['==', ['get', 'mode'], 'bike'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': rc.bike, 'line-width': 6, 'line-opacity': ['case', ['==', ['get', 'done'], 1], 0.35, 1] } })
  // The chosen route colored by kind of way (bike path, lane, shared lane, quiet street, busy road…), drawn
  // over the plain line once its details have loaded.
  if (!map.getLayer(L.routeKinds))
    map.addLayer({ id: L.routeKinds, type: 'line', source: S.routeKinds, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': pathColorExpr(dark), 'line-width': 6 } })
  if (!map.getLayer(L.stationSelected))
    map.addLayer({ id: L.stationSelected, type: 'circle', source: S.stations, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 9, 15, 20], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': ['case', ['boolean', ['feature-state', 'selected'], false], 4, ['!=', ['get', 'planRole'], ''], 3, 0], 'circle-stroke-color': ['case', ['==', ['get', 'planRole'], 'backup'], '#94a3b8', '#2563eb'] } })
  // Starred docks: a gold ring just outside the station circle.
  if (!map.getLayer(L.stationStarred))
    map.addLayer({ id: L.stationStarred, type: 'circle', source: S.stations, filter: STARRED_FILTER, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 13, 11, 16, 17.5], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': STAR_GOLD, 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 3.5] } })
  if (!map.getLayer(L.stationCircle))
    map.addLayer({ id: L.stationCircle, type: 'circle', source: S.stations, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 13, 8, 16, 14], 'circle-color': colorExpr(view), 'circle-stroke-color': strokeExpr(view), 'circle-stroke-width': 2 } })
  if (!map.getLayer(L.stationCount))
    map.addLayer({ id: L.stationCount, type: 'symbol', source: S.stations, minzoom: 12.5, layout: { 'text-field': labelExpr(view), 'text-font': [...MAP.labelFont], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 14], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': labelColorExpr(view) } })
  if (!map.getLayer(L.endpoints))
    map.addLayer({ id: L.endpoints, type: 'circle', source: S.endpoints, filter: ['in', ['get', 'kind'], ['literal', ['origin', 'destination']]], paint: { 'circle-radius': 7, 'circle-color': ['match', ['get', 'kind'], 'destination', '#dc2626', '#0f172a'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } })
  // Home, Work and favorite places, above stations and route (but under the rider's own dot).
  if (!map.getLayer(L.savedPlaces))
    map.addLayer({ id: L.savedPlaces, type: 'symbol', source: S.saved, layout: { 'icon-image': ['match', ['get', 'icon'], 'home', savedImageId('home'), 'work', savedImageId('work'), savedImageId('star')], 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.7, 14, 1], 'icon-allow-overlap': true, 'icon-ignore-placement': true } })
  if (!map.getLayer(L.userAccuracy))
    map.addLayer({ id: L.userAccuracy, type: 'fill', source: S.user, filter: ['==', ['get', 'part'], 'accuracy'], paint: { 'fill-color': USER_PUCK.accuracy } })
  if (!map.getLayer(L.userPuck))
    map.addLayer({ id: L.userPuck, type: 'circle', source: S.user, filter: ['==', ['get', 'part'], 'puck'], paint: { 'circle-radius': 8, 'circle-color': ['match', ['get', 'quality'], 'good', USER_PUCK.fill, USER_PUCK.degraded], 'circle-stroke-color': USER_PUCK.stroke, 'circle-stroke-width': 3 } })
}

const STARRED_FILTER = ['==', ['get', 'starred'], true] as never

const source = (map: MlMap, id: string) => map.getSource(id) as GeoJSONSource | undefined

/** The point feature of `layer` nearest to a tap, within MAP.tapSlopPx, and its distance in px. */
function featureNear(map: MlMap, at: { x: number; y: number }, layer: string): { feature: MapGeoJSONFeature; px: number } | null {
  if (!map.getLayer(layer)) return null
  const slop = MAP.tapSlopPx
  const box: [[number, number], [number, number]] = [
    [at.x - slop, at.y - slop],
    [at.x + slop, at.y + slop],
  ]
  let best: { feature: MapGeoJSONFeature; px: number } | null = null
  for (const feature of map.queryRenderedFeatures(box, { layers: [layer] })) {
    if (feature.geometry.type !== 'Point') continue
    const p = map.project(feature.geometry.coordinates as [number, number])
    const px = Math.hypot(p.x - at.x, p.y - at.y)
    if (!best || px < best.px) best = { feature, px }
  }
  return best
}

/** A camera change asked for before the map runtime had loaded (applied without animation once it has). */
type PendingCamera = { kind: 'fly'; center: LngLat; zoom?: number } | { kind: 'fit'; bbox: BBox; maxZoom?: number }

export function MapView({ ref, onStationClick, onBackgroundClick, onMapPick, onError }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null)
  const msg = useT()
  const mapRef = useRef<MlMap | null>(null)
  const readyRef = useRef(false)
  const lastStationsKey = useRef('')
  /** The style URL the map has (or is loading), so an unchanged theme never reloads it. */
  const appliedStyle = useRef<string | null>(null)
  /** The station whose feature-state is `selected` on the map. */
  const selectedOnMap = useRef<string | null>(null)
  const pendingCamera = useRef<PendingCamera | null>(null)
  const padding = useRef<Padding | null>(null)
  const { systemId, mode, selectedStationId, settings, starred, saved } = useAppStore(
    useShallow((s) => ({ systemId: s.systemId, mode: s.mapMode, selectedStationId: s.selectedStationId, settings: s.settings, starred: s.starredStations, saved: s.savedPlaces })),
  )
  const ride = useRideStore(useShallow((s) => ({ route: s.route, routes: s.routes, startId: s.startId, stopIds: s.stopIds, destination: s.destination, origin: s.origin })))
  const rolesKey = `${ride.startId ?? ''}|${ride.stopIds.join(',')}`
  const dark = isDarkStyle(settings.mapStyle, usePrefersDark())
  const styleUrl = dark ? MAP.styles.dark : MAP.styles.light
  const { snapshot } = useStationsSnapshot(systemId)
  const mixedFleet = useMemo(() => !!snapshot && fleetComposition(snapshot.stations) === 'mixed', [snapshot])
  const view: StationView = mode === 'bikes' && settings.preferEbikes && mixedFleet ? 'ebikes' : mode
  const { details } = useRouteDetails(systemId, ride.route)
  // While planning (route shown, ride not started), only the docks that matter stay on the map: the start
  // dock, the chosen stops and the other docks offered along the route. During the ride every dock shows
  // again (the rider may need another one). Uses the planner's own list, so the two never disagree.
  const panel = useAppStore((s) => s.panel)
  const riding = useRideStore((s) => s.openedParts.length > 0 || s.walkToDockOpened)
  const plan = useRidePlan()
  const routeDockIds = useMemo(
    () => (panel === 'ride' && !riding && ride.route && ride.startId ? [...new Set([ride.startId, ...ride.stopIds, ...plan.along.map((d) => d.station.id)])] : null),
    [panel, riding, ride.route, ride.startId, ride.stopIds, plan.along],
  )
  // Walking legs only need the two docks' positions; keyed by value so station polls don't re-upload the route.
  const endId = ride.stopIds.at(-1)
  const startCoord = ride.startId ? snapshot?.byId.get(ride.startId)?.coord : undefined
  const endCoord = endId ? snapshot?.byId.get(endId)?.coord : undefined
  const walkKey = `${startCoord?.join(',') ?? ''}|${endCoord?.join(',') ?? ''}`
  // Everything the station features depend on: the city (revisions restart at 1 in each city), its data
  // revision, the party size (availability colors), plan roles and stars.
  const stationsKey = snapshot ? `${snapshot.systemId}|${snapshot.revision}|${settings.partySize}|${rolesKey}|${starred.join(',')}` : ''
  // Everything the route layers depend on.
  const routeScene = useMemo(
    () => ({ route: ride.route, routes: ride.routes, destination: ride.destination, origin: ride.origin, segments: details?.segments, walkKey }),
    [ride.route, ride.routes, ride.destination, ride.origin, details, walkKey],
  )

  const emitStation = useEffectEvent((id: string) => onStationClick(id))
  const emitBackground = useEffectEvent(() => onBackgroundClick())
  const emitPick = useEffectEvent((c: [number, number]) => onMapPick(c))
  const emitError = useEffectEvent((e: AppError) => onError(e))
  const applyDockFilter = useEffectEvent((ids: readonly string[] | null) => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    const filter = ids ? (['in', ['get', 'id'], ['literal', ids]] as never) : null
    for (const id of [L.stationCircle, L.stationCount, L.stationSelected]) if (map.getLayer(id)) map.setFilter(id, filter)
    if (map.getLayer(L.stationStarred)) map.setFilter(L.stationStarred, filter ? (['all', STARRED_FILTER, filter] as never) : STARRED_FILTER)
  })
  const syncSaved = useEffectEvent((places: typeof saved, sid: string | null) => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    void source(map, S.saved)?.setData(buildSavedPlaceFeatures(places, sid) as never)
  })
  const syncStations = useEffectEvent((key: string) => {
    const map = mapRef.current
    if (!map || !readyRef.current || !snapshot || key === lastStationsKey.current) return
    lastStationsKey.current = key
    const sid = snapshot.systemId
    const star = new Set(starred.filter((k) => k.startsWith(`${sid}:`)).map((k) => k.slice(sid.length + 1)))
    void source(map, S.stations)?.setData(buildStationFeatures(snapshot, { partySize: settings.partySize, starred: star, roles: rideRoles(ride.startId, ride.stopIds) }) as never)
  })
  const applySelection = useEffectEvent((id: string | null) => {
    const map = mapRef.current
    if (!map || !readyRef.current || !map.getSource(S.stations)) return
    const prev = selectedOnMap.current
    if (prev && prev !== id) map.setFeatureState({ source: S.stations, id: prev }, { selected: false })
    if (id) map.setFeatureState({ source: S.stations, id }, { selected: true })
    selectedOnMap.current = id
  })
  const syncRoute = useEffectEvent((scene: typeof routeScene) => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    const { route, destination } = scene
    // Other route options faded underneath, the chosen one on top.
    const others = scene.routes.filter((r) => r !== route)
    const routes = buildRouteFeatures(route ? [...others, route] : [], others.length)
    // Walking legs: from a starting place to the pickup dock, and from the end dock to the destination.
    const origin = scene.origin && !scene.origin.stationId ? scene.origin.coord : null
    const walks: Array<[[number, number], [number, number]]> = []
    if (origin && startCoord) walks.push([origin, startCoord])
    if (route && endCoord && destination) walks.push([endCoord, destination.coord])
    routes.features.push(...buildWalkFeatures(walks))
    void source(map, S.route)?.setData(routes as never)
    void source(map, S.routeKinds)?.setData(buildPathKindFeatures(route ? (scene.segments ?? []) : []) as never)
    void source(map, S.endpoints)?.setData(buildEndpointFeatures(destination?.coord ?? null, origin) as never)
  })
  // User location dot, outside React.
  const drawUser = useEffectEvent(() => {
    const map = mapRef.current
    const fix = useLocationStore.getState().fix
    if (!map || !readyRef.current) return
    void source(map, S.user)?.setData(buildUserFeatures(fix, fix && fix.accuracy <= 30 ? 'good' : 'degraded', fix?.heading ?? null) as never)
  })
  /** Everything onto a freshly loaded style (first load, or after a theme change). */
  const redraw = useEffectEvent(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    ensureLayers(map, view, dark)
    applyDockFilter(routeDockIds)
    // A (re)loaded style starts with empty sources and no feature-state.
    lastStationsKey.current = ''
    selectedOnMap.current = null
    syncStations(stationsKey)
    applySelection(selectedStationId)
    syncRoute(routeScene)
    syncSaved(saved, systemId)
    drawUser()
  })

  /** Creates the map once the runtime has loaded, with the current theme, padding and camera. */
  const createMap = useEffectEvent((ml: typeof import('./maplibre')): (() => void) | undefined => {
    const el = container.current
    if (!el) return
    const sys = getSystem(systemId)
    let map: MlMap
    try {
      map = new ml.Map({
        container: el,
        style: styleUrl,
        center: sys?.center ?? [-96, 39],
        zoom: sys ? MAP.defaultZoom : 3,
        attributionControl: { compact: true, customAttribution: ATTRIBUTION },
        // Automated browsers (screenshots/e2e) need the buffer kept; real users skip the cost.
        canvasContextAttributes: { contextType: 'webgl2', preserveDrawingBuffer: typeof navigator !== 'undefined' && navigator.webdriver === true },
      })
    } catch (err) {
      markMapSettled()
      emitError(new AppError('webgl_unavailable', err instanceof ml.GPUInitializationError ? 'WebGL2 is unavailable' : 'Map failed to start', { cause: err }))
      return
    }
    map.once('load', markMapSettled)
    mapRef.current = map
    appliedStyle.current = styleUrl
    // What the rest of the app asked for while the runtime was loading.
    if (padding.current) map.setPadding(padding.current)
    const pending = pendingCamera.current
    pendingCamera.current = null
    if (pending?.kind === 'fly') map.jumpTo({ center: pending.center, zoom: pending.zoom ?? 15 })
    else if (pending?.kind === 'fit') map.fitBounds([[pending.bbox[0], pending.bbox[1]], [pending.bbox[2], pending.bbox[3]]], { maxZoom: pending.maxZoom ?? 16, duration: 0 })
    else if (sys) map.fitBounds([[sys.bbox[0], sys.bbox[1]], [sys.bbox[2], sys.bbox[3]]], { padding: 40, maxZoom: 14, duration: 0 })

    map.on('style.load', () => {
      readyRef.current = true
      redraw()
    })
    // One long press can produce both our touch timer and the browser's contextmenu (Android), and then a
    // click: one pick, and the press's own click doesn't count as a tap on the map.
    let lastPickAt = -Infinity
    const pick = (c: [number, number]) => {
      if (Date.now() - lastPickAt < MAP.afterPickIgnoreMs) return
      lastPickAt = Date.now()
      emitPick(c)
    }
    map.on('click', (e: MapMouseEvent) => {
      if (Date.now() - lastPickAt < MAP.afterPickIgnoreMs) return
      // A saved place (marker drawn on top) opens its place card at the exact saved spot; otherwise the
      // nearest station dot within reach of the finger.
      const savedHit = featureNear(map, e.point, L.savedPlaces)
      const stationHit = featureNear(map, e.point, L.stationCircle)
      const savedPlace = savedHit && (!stationHit || savedHit.px <= stationHit.px) ? useAppStore.getState().savedPlaces.find((p) => p.id === savedHit.feature.properties?.id) : undefined
      if (savedPlace) return emitPick(savedPlace.place.coord)
      const id = stationHit?.feature.properties?.id
      if (typeof id === 'string') emitStation(id)
      else emitBackground()
    })
    // Long-press (touch) or right-click → pick a point.
    let timer: ReturnType<typeof setTimeout> | null = null
    let start: { x: number; y: number } | null = null
    const canvas = map.getCanvasContainer()
    const cancel = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    map.on('contextmenu', (e: MapMouseEvent) => {
      cancel()
      pick([e.lngLat.lng, e.lngLat.lat])
    })
    const onTouchStart = (e: TouchEvent) => {
      cancel()
      if (e.touches.length !== 1) return
      const t = e.touches[0]!
      start = { x: t.clientX, y: t.clientY }
      timer = setTimeout(() => {
        timer = null
        if (!start) return
        const rect = canvas.getBoundingClientRect()
        const ll = map.unproject([start.x - rect.left, start.y - rect.top])
        pick([ll.lng, ll.lat])
      }, MAP.longPressMs)
    }
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (e.touches.length !== 1 || (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > MAP.longPressMovePx)) cancel()
    }
    canvas.addEventListener('touchstart', onTouchStart, { passive: true })
    canvas.addEventListener('touchmove', onTouchMove, { passive: true })
    canvas.addEventListener('touchend', cancel)
    canvas.addEventListener('touchcancel', cancel)
    map.on('error', (e) => console.warn('[map]', (e as unknown as { error?: Error }).error?.message ?? e))
    return () => {
      cancel()
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('touchend', cancel)
      canvas.removeEventListener('touchcancel', cancel)
      readyRef.current = false
      mapRef.current = null
      appliedStyle.current = null
      map.remove()
    }
  })

  // Create the map once, when its runtime has loaded.
  useEffect(() => {
    let cancelled = false
    let destroy: (() => void) | undefined
    runtime.then(
      (ml) => {
        if (!cancelled) destroy = createMap(ml)
      },
      (err: unknown) => {
        markMapSettled()
        if (!cancelled) emitError(new AppError('network', 'The map could not be loaded', { cause: err }))
      },
    )
    return () => {
      cancelled = true
      destroy?.()
    }
  }, [])

  // Before the map exists, camera changes are kept and applied when it is created (see createMap).
  useImperativeHandle(
    ref,
    () => ({
      flyTo: (center, o) => {
        const map = mapRef.current
        if (!map) pendingCamera.current = { kind: 'fly', center, zoom: o?.zoom }
        else map.flyTo({ center, zoom: o?.zoom ?? Math.max(map.getZoom(), 15), duration: o?.durationMs ?? 800 })
      },
      fitBounds: (b, o) => {
        const map = mapRef.current
        if (!map) pendingCamera.current = { kind: 'fit', bbox: b, maxZoom: o?.maxZoom }
        else map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { maxZoom: o?.maxZoom ?? 16, duration: o?.durationMs ?? 800 })
      },
      setPadding: (p) => {
        padding.current = p
        mapRef.current?.setPadding(p)
      },
      getViewport: () => {
        const m = mapRef.current
        if (!m) return null
        const b = m.getBounds()
        const c = m.getCenter()
        return { center: [c.lng, c.lat], bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], zoom: m.getZoom() }
      },
    }),
    [],
  )

  // Theme: only a different style is loaded (the map already has the one it was created with).
  useEffect(() => {
    const map = mapRef.current
    if (!map || appliedStyle.current === styleUrl) return
    appliedStyle.current = styleUrl
    readyRef.current = false
    map.setStyle(styleUrl)
  }, [styleUrl])

  // Bikes / Docks / e-bikes → paint/layout only (data unchanged).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current || !map.getLayer(L.stationCircle)) return
    map.setPaintProperty(L.stationCircle, 'circle-color', colorExpr(view))
    map.setPaintProperty(L.stationCircle, 'circle-stroke-color', strokeExpr(view))
    map.setLayoutProperty(L.stationCount, 'text-field', labelExpr(view))
    map.setPaintProperty(L.stationCount, 'text-color', labelColorExpr(view))
  }, [view])

  useEffect(() => {
    syncStations(stationsKey)
  }, [stationsKey])
  useEffect(() => {
    syncRoute(routeScene)
  }, [routeScene])
  useEffect(() => {
    applyDockFilter(routeDockIds)
  }, [routeDockIds])
  useEffect(() => {
    syncSaved(saved, systemId)
  }, [saved, systemId])
  // Selection via feature-state.
  useEffect(() => {
    applySelection(selectedStationId)
  }, [selectedStationId])

  // Fly to the system when it changes (the first one is framed when the map is created).
  useEffect(() => {
    const sys = getSystem(systemId)
    const map = mapRef.current
    if (!sys || !map) return
    map.fitBounds([[sys.bbox[0], sys.bbox[1]], [sys.bbox[2], sys.bbox[3]]], { padding: 40, maxZoom: 14, duration: 0 })
  }, [systemId])

  useEffect(() => useLocationStore.subscribe((s) => s.fix, () => drawUser()), [])

  // Wrapper owns positioning: maplibre's CSS sets .maplibregl-map { position: relative } on the inner div.
  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" role="application" aria-label={msg.mapAria} />
    </div>
  )
}
