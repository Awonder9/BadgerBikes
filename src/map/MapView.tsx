// The single map (mounted once at the app root). Only this file imports the maplibre runtime.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { GPUInitializationError, Map as MlMap, setWorkerUrl, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl'
import { useEffect, useEffectEvent, useImperativeHandle, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { MAP } from '../config'
import { getSystem } from '../data/systems'
import { useStationsSnapshot } from '../data/hooks'
import { AppError } from '../lib/errors'
import { useAppStore } from '../store/appStore'
import { useLocationStore } from '../location/locationStore'
import type { MapMode } from '../types'
import { useRideStore } from '../ride/rideStore'
import { AVAILABILITY_COLORS, PATH_COLORS, ROUTE_COLORS, USER_PUCK } from './colors'
import { useRouteDetails } from '../data/routeDetails'
import type { PathKind } from '../routing/details'
import { buildEndpointFeatures, buildPathKindFeatures, buildRouteFeatures, buildWalkFeatures, buildStationFeatures, buildUserFeatures, emptyCollection, rideRoles } from './features'
import { LAYER_IDS as L, SOURCE_IDS as S, type MapViewProps } from './types'

setWorkerUrl(workerUrl)

const ATTRIBUTION = [
  'Routing: <a href="https://valhalla1.openstreetmap.de">Valhalla</a> &amp; OSRM by FOSSGIS',
  'Search: <a href="https://photon.komoot.io">Photon</a>',
  '<a href="https://www.openstreetmap.org/fixthemap">Report a map problem</a>',
]

function colorExpr(mode: MapMode) {
  const prop = mode === 'bikes' ? 'bikeState' : 'dockState'
  return ['match', ['get', prop], 'ok', AVAILABILITY_COLORS.ok, 'low', AVAILABILITY_COLORS.low, 'none', '#ffffff', AVAILABILITY_COLORS.unavailable] as never
}
function strokeExpr(mode: MapMode) {
  const prop = mode === 'bikes' ? 'bikeState' : 'dockState'
  return ['match', ['get', prop], 'none', AVAILABILITY_COLORS.none, '#ffffff'] as never
}
function labelExpr(mode: MapMode) {
  const prop = mode === 'bikes' ? 'bikeState' : 'dockState'
  return ['case', ['==', ['get', prop], 'unavailable'], '✕', ['to-string', ['get', mode]]] as never
}
function labelColorExpr(mode: MapMode) {
  const prop = mode === 'bikes' ? 'bikeState' : 'dockState'
  return ['match', ['get', prop], 'none', AVAILABILITY_COLORS.none, '#ffffff'] as never
}

function pathColorExpr(dark: boolean) {
  const entries = (Object.entries(PATH_COLORS) as Array<[PathKind, string]>).flatMap(([k, c]) => [k, dark && k === 'quietStreet' ? '#94a3b8' : c])
  return ['match', ['get', 'kind'], ...entries, '#0f766e'] as never
}

function isDark(style: 'auto' | 'light' | 'dark'): boolean {
  if (style !== 'auto') return style === 'dark'
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
}

function ensureLayers(map: MlMap, mode: MapMode, dark: boolean) {
  const rc = dark ? ROUTE_COLORS.dark : ROUTE_COLORS.light
  if (!map.getSource(S.route)) map.addSource(S.route, { type: 'geojson', data: emptyCollection() })
  if (!map.getSource(S.stations)) map.addSource(S.stations, { type: 'geojson', data: emptyCollection(), promoteId: 'id' })
  if (!map.getSource(S.routeKinds)) map.addSource(S.routeKinds, { type: 'geojson', data: emptyCollection() })
  if (!map.getSource(S.endpoints)) map.addSource(S.endpoints, { type: 'geojson', data: emptyCollection() })
  if (!map.getSource(S.user)) map.addSource(S.user, { type: 'geojson', data: emptyCollection() })
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
  if (!map.getLayer(L.stationCircle))
    map.addLayer({ id: L.stationCircle, type: 'circle', source: S.stations, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 13, 8, 16, 14], 'circle-color': colorExpr(mode), 'circle-stroke-color': strokeExpr(mode), 'circle-stroke-width': 2 } })
  if (!map.getLayer(L.stationCount))
    map.addLayer({ id: L.stationCount, type: 'symbol', source: S.stations, minzoom: 12.5, layout: { 'text-field': labelExpr(mode), 'text-font': [...MAP.labelFont], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 14], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': labelColorExpr(mode) } })
  if (!map.getLayer(L.endpoints))
    map.addLayer({ id: L.endpoints, type: 'circle', source: S.endpoints, filter: ['in', ['get', 'kind'], ['literal', ['origin', 'destination']]], paint: { 'circle-radius': 7, 'circle-color': ['match', ['get', 'kind'], 'destination', '#dc2626', '#0f172a'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } })
  if (!map.getLayer(L.userAccuracy))
    map.addLayer({ id: L.userAccuracy, type: 'fill', source: S.user, filter: ['==', ['get', 'part'], 'accuracy'], paint: { 'fill-color': USER_PUCK.accuracy } })
  if (!map.getLayer(L.userPuck))
    map.addLayer({ id: L.userPuck, type: 'circle', source: S.user, filter: ['==', ['get', 'part'], 'puck'], paint: { 'circle-radius': 8, 'circle-color': ['match', ['get', 'quality'], 'good', USER_PUCK.fill, USER_PUCK.degraded], 'circle-stroke-color': USER_PUCK.stroke, 'circle-stroke-width': 3 } })
}

const source = (map: MlMap, id: string) => map.getSource(id) as GeoJSONSource | undefined

export function MapView({ ref, onStationClick, onBackgroundClick, onMapPick, onError }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const readyRef = useRef(false)
  const lastRevision = useRef('')
  const { systemId, mode, selectedStationId, settings, starred } = useAppStore(
    useShallow((s) => ({ systemId: s.systemId, mode: s.mapMode, selectedStationId: s.selectedStationId, settings: s.settings, starred: s.starredStations })),
  )
  const ride = useRideStore(useShallow((s) => ({ route: s.route, routes: s.routes, startId: s.startId, stopIds: s.stopIds, destination: s.destination, origin: s.origin })))
  const roles = rideRoles(ride.startId, ride.stopIds)
  const rolesKey = `${ride.startId ?? ''}|${ride.stopIds.join(',')}`
  const dark = isDark(settings.mapStyle)
  const { snapshot } = useStationsSnapshot(systemId)
  const { details } = useRouteDetails(systemId, ride.route)
  // Walking legs only need the two docks' positions; keyed by value so station polls don't re-upload the route.
  const endId = ride.stopIds.at(-1)
  const startCoord = ride.startId ? snapshot?.byId.get(ride.startId)?.coord : undefined
  const endCoord = endId ? snapshot?.byId.get(endId)?.coord : undefined
  const walkKey = `${startCoord?.join(',') ?? ''}|${endCoord?.join(',') ?? ''}`

  const emitStation = useEffectEvent((id: string) => onStationClick(id))
  const emitBackground = useEffectEvent(() => onBackgroundClick())
  const emitPick = useEffectEvent((c: [number, number]) => onMapPick(c))
  const emitError = useEffectEvent((e: AppError) => onError(e))
  const redraw = useEffectEvent(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    ensureLayers(map, mode, dark)
    lastRevision.current = ''
    syncStations()
    syncRoute()
    drawUser()
  })
  const syncStations = useEffectEvent(() => {
    const map = mapRef.current
    if (!map || !readyRef.current || !snapshot) return
    const sid = snapshot.systemId
    const key = `${snapshot.revision}|${rolesKey}|${starred.length}`
    if (key === lastRevision.current) return
    lastRevision.current = key
    const star = new Set(starred.filter((k) => k.startsWith(`${sid}:`)).map((k) => k.slice(sid.length + 1)))
    void source(map, S.stations)?.setData(buildStationFeatures(snapshot, { partySize: settings.partySize, starred: star, roles }) as never)
  })
  const syncRoute = useEffectEvent(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    // Other route options faded underneath, the chosen one on top.
    const others = ride.routes.filter((r) => r !== ride.route)
    const routes = buildRouteFeatures(ride.route ? [...others, ride.route] : [], others.length)
    // Walking legs: from a starting place to the pickup dock, and from the end dock to the destination.
    const origin = ride.origin && !ride.origin.stationId ? ride.origin.coord : null
    const walks: Array<[[number, number], [number, number]]> = []
    if (origin && startCoord) walks.push([origin, startCoord])
    if (ride.route && endCoord && ride.destination) walks.push([endCoord, ride.destination.coord])
    routes.features.push(...buildWalkFeatures(walks))
    void source(map, S.route)?.setData(routes as never)
    void source(map, S.routeKinds)?.setData(buildPathKindFeatures(ride.route ? (details?.segments ?? []) : []) as never)
    void source(map, S.endpoints)?.setData(buildEndpointFeatures(ride.destination?.coord ?? null, origin) as never)
  })

  // Create the map once.
  useEffect(() => {
    if (!container.current) return
    const sys = getSystem(useAppStore.getState().systemId)
    let map: MlMap
    try {
      map = new MlMap({
        container: container.current,
        style: dark ? MAP.styles.dark : MAP.styles.light,
        center: sys?.center ?? [-96, 39],
        zoom: sys ? MAP.defaultZoom : 3,
        attributionControl: { compact: true, customAttribution: ATTRIBUTION },
        // Automated browsers (screenshots/e2e) need the buffer kept; real users skip the cost.
        canvasContextAttributes: { contextType: 'webgl2', preserveDrawingBuffer: typeof navigator !== 'undefined' && navigator.webdriver === true },
      })
    } catch (err) {
      emitError(new AppError('webgl_unavailable', err instanceof GPUInitializationError ? 'WebGL2 is unavailable' : 'Map failed to start', { cause: err }))
      return
    }
    mapRef.current = map
    map.on('style.load', () => {
      readyRef.current = true
      redraw()
    })
    map.on('click', (e: MapMouseEvent) => {
      const hit = map.queryRenderedFeatures(e.point, { layers: [L.stationCircle] })[0]
      const id = hit?.properties?.id
      if (typeof id === 'string') emitStation(id)
      else emitBackground()
    })
    map.on('contextmenu', (e: MapMouseEvent) => emitPick([e.lngLat.lng, e.lngLat.lat]))
    // Long-press (touch) → pick a point.
    let timer: ReturnType<typeof setTimeout> | null = null
    let start: { x: number; y: number } | null = null
    const canvas = map.getCanvasContainer()
    const cancel = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return cancel()
      const t = e.touches[0]!
      start = { x: t.clientX, y: t.clientY }
      timer = setTimeout(() => {
        const rect = canvas.getBoundingClientRect()
        const ll = map.unproject([start!.x - rect.left, start!.y - rect.top])
        emitPick([ll.lng, ll.lat])
      }, 500)
    }
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel()
    }
    canvas.addEventListener('touchstart', onTouchStart, { passive: true })
    canvas.addEventListener('touchmove', onTouchMove, { passive: true })
    canvas.addEventListener('touchend', cancel)
    map.on('error', (e) => console.warn('[map]', (e as unknown as { error?: Error }).error?.message ?? e))
    return () => {
      cancel()
      readyRef.current = false
      mapRef.current = null
      map.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once; later changes are applied below
  }, [])

  useImperativeHandle(ref, () => ({
    flyTo: (center, o) => mapRef.current?.flyTo({ center, zoom: o?.zoom ?? Math.max(mapRef.current.getZoom(), 15), duration: o?.durationMs ?? 800 }),
    fitBounds: (b, o) => mapRef.current?.fitBounds([[b[0], b[1]], [b[2], b[3]]], { maxZoom: o?.maxZoom ?? 16, duration: o?.durationMs ?? 800 }),
    setPadding: (p) => mapRef.current?.setPadding(p),
    getViewport: () => {
      const m = mapRef.current
      if (!m) return null
      const b = m.getBounds()
      const c = m.getCenter()
      return { center: [c.lng, c.lat], bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], zoom: m.getZoom() }
    },
  }))

  // Theme.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    readyRef.current = false
    map.setStyle(dark ? MAP.styles.dark : MAP.styles.light)
  }, [dark])

  // Mode → paint/layout only (data unchanged).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current || !map.getLayer(L.stationCircle)) return
    map.setPaintProperty(L.stationCircle, 'circle-color', colorExpr(mode))
    map.setPaintProperty(L.stationCircle, 'circle-stroke-color', strokeExpr(mode))
    map.setLayoutProperty(L.stationCount, 'text-field', labelExpr(mode))
    map.setPaintProperty(L.stationCount, 'text-color', labelColorExpr(mode))
  }, [mode])

  useEffect(() => {
    syncStations()
  }, [snapshot, rolesKey, starred, settings.partySize])
  useEffect(() => {
    syncRoute()
  }, [ride.route, ride.routes, ride.destination, ride.origin, walkKey, details])

  // Selection via feature-state.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current || !selectedStationId) return
    map.setFeatureState({ source: S.stations, id: selectedStationId }, { selected: true })
    return () => {
      if (mapRef.current?.getSource(S.stations)) mapRef.current.setFeatureState({ source: S.stations, id: selectedStationId }, { selected: false })
    }
  }, [selectedStationId, snapshot])

  // Fly to the system when it changes.
  useEffect(() => {
    const sys = getSystem(systemId)
    const map = mapRef.current
    if (!sys || !map) return
    map.fitBounds([[sys.bbox[0], sys.bbox[1]], [sys.bbox[2], sys.bbox[3]]], { padding: 40, maxZoom: 14, duration: 0 })
  }, [systemId])

  // User location dot, outside React.
  const drawUser = useEffectEvent(() => {
    const map = mapRef.current
    const fix = useLocationStore.getState().fix
    if (!map || !readyRef.current) return
    void source(map, S.user)?.setData(buildUserFeatures(fix, fix && fix.accuracy <= 30 ? 'good' : 'degraded', fix?.heading ?? null) as never)
  })
  useEffect(() => useLocationStore.subscribe((s) => s.fix, () => drawUser()), [])

  // Wrapper owns positioning: maplibre's CSS sets .maplibregl-map { position: relative } on the inner div.
  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" role="application" aria-label="Map of bike-share stations" />
    </div>
  )
}
