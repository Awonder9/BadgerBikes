// The single map (mounted once at the app root). The maplibre runtime is loaded on demand from ./maplibre
// (this file imports only its types): it is most of the app's JavaScript, so it downloads in parallel with
// the first station request instead of before it. Until it has loaded, the map API queues camera changes.
import type { GeoJSONSource, MapGeoJSONFeature, MapMouseEvent, Map as MlMap } from 'maplibre-gl'
import { useEffect, useEffectEvent, useImperativeHandle, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { BIKE_ROUTING, MAP } from '../config'
import { getSystem } from '../data/systems'
import { useStationsSnapshot } from '../data/hooks'
import { AppError } from '../lib/errors'
import { fleetComposition } from '../lib/stationState'
import { useAppStore } from '../store/appStore'
import { useT } from '../i18n/useT'
import { useLocationStore } from '../location/locationStore'
import type { BBox, LngLat, MapMode } from '../types'
import { endDockState, replacementDocks } from '../ride/rideProgress'
import { useRideStore, rideActive } from '../ride/rideStore'
import { useTripStore } from '../ride/tripStore'
import { isDarkStyle, usePrefersDark } from '../ui/useMediaQuery'
import { useRidePlan } from '../ui/ride/useRidePlan'
import { useRideLines } from '../ui/ride/useRideLines'
import { AVAILABILITY_COLORS, PATH_COLORS, ROUTE_COLORS, STAR_GOLD, USER_PUCK } from './colors'
import { markMapSettled } from './mapSettled'
import { addSavedIcons, savedImageId } from './savedIcons'
import { useRouteDetails } from '../data/routeDetails'
import type { PathKind } from '../routing/details'
import { buildEndpointFeatures, buildSavedPlaceFeatures, buildPastLegFeatures, buildPathKindFeatures, clipSegments, buildRouteFeatures, buildWalkFeatures, buildStationFeatures, buildUserFeatures, emptyCollection, rideRoles } from './features'
import { LAYER_IDS as L, SOURCE_IDS as S, type MapViewProps, type Padding, type StationFeatureProps } from './types'

// Starts downloading the map runtime as soon as the app starts. A failure is reported when the map is created.
const runtime = import('./maplibre')
runtime.catch(() => {})

// Opened beside the app: in the Home Screen app there is no browser bar to come back from another site.
const link = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
const ATTRIBUTION = [
  `Routing: ${link('https://valhalla1.openstreetmap.de', 'Valhalla')} &amp; OSRM by FOSSGIS`,
  `Search: ${link('https://photon.komoot.io', 'Photon')}`,
  link('https://www.openstreetmap.org/fixthemap', 'Report a map problem'),
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
  if (!map.getLayer(L.routeBikeCasing))
    map.addLayer({ id: L.routeBikeCasing, type: 'line', source: S.route, filter: ['==', ['get', 'mode'], 'bike'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': rc.bikeCasing, 'line-width': ['case', ['==', ['get', 'light'], 1], 6, ['==', ['get', 'past'], 1], 7, 9] } })
  if (!map.getLayer(L.routeBike))
    map.addLayer({ id: L.routeBike, type: 'line', source: S.route, filter: ['==', ['get', 'mode'], 'bike'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['case', ['==', ['get', 'past'], 1], rc.past, rc.bike], 'line-width': ['case', ['==', ['get', 'light'], 1], 3.5, ['==', ['get', 'past'], 1], 4.5, 6], 'line-opacity': ['case', ['==', ['get', 'done'], 1], 0.35, ['==', ['get', 'light'], 1], 0.7, ['==', ['get', 'past'], 1], 0.85, 1] } })
  // The chosen route colored by kind of way (bike path, lane, shared lane, quiet street, busy road…), drawn
  // over the plain line once its details have loaded.
  if (!map.getLayer(L.routeKinds))
    map.addLayer({ id: L.routeKinds, type: 'line', source: S.routeKinds, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': pathColorExpr(dark), 'line-width': 6 } })
  // Walks on top: they often follow the same streets as a route line, which would hide them.
  if (!map.getLayer(L.routeWalk))
    map.addLayer({ id: L.routeWalk, type: 'line', source: S.route, filter: ['==', ['get', 'mode'], 'walk'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': rc.walk, 'line-width': 4, 'line-dasharray': [0.1, 2], 'line-opacity': ['case', ['==', ['get', 'done'], 1], 0.35, 1] } })
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
    map.addLayer({ id: L.endpoints, type: 'circle', source: S.endpoints, filter: ['in', ['get', 'kind'], ['literal', ['origin', 'destination', 'tripStop']]], paint: { 'circle-radius': ['match', ['get', 'kind'], 'tripStop', 6, 7], 'circle-color': ['match', ['get', 'kind'], 'destination', '#dc2626', 'tripStop', '#7c3aed', '#0f172a'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } })
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

/** Whether `coord` shows in the map's unobscured part (inside the padding: not under the panel or map buttons). */
function inView(map: MlMap, coord: LngLat, pad: Padding | null): boolean {
  const p = map.project(coord)
  const el = map.getContainer()
  const m = MAP.revealMarginPx
  return p.x >= (pad?.left ?? 0) + m && p.x <= el.clientWidth - (pad?.right ?? 0) - m && p.y >= (pad?.top ?? 0) + m && p.y <= el.clientHeight - (pad?.bottom ?? 0) - m
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
  /** The selected station already brought into view (each selection moves the camera at most once). */
  const revealed = useRef<string | null>(null)
  /** The station dot last tapped, and when: a tap selects what the rider is looking at, so the map stays put. */
  const lastTap = useRef<{ id: string; atMs: number } | null>(null)
  const pendingCamera = useRef<PendingCamera | null>(null)
  const padding = useRef<Padding | null>(null)
  const { systemId, mode, selectedStationId, settings, starred, saved } = useAppStore(
    useShallow((s) => ({ systemId: s.systemId, mode: s.mapMode, selectedStationId: s.selectedStationId, settings: s.settings, starred: s.starredStations, saved: s.savedPlaces })),
  )
  const ride = useRideStore(useShallow((s) => ({ route: s.route, routes: s.routes, routeIndex: s.routeIndex, pastLegs: s.pastLegs, startId: s.startId, stopIds: s.stopIds, destination: s.destination, origin: s.origin })))
  const rolesKey = `${ride.startId ?? ''}|${ride.stopIds.join(',')}`
  const dark = isDarkStyle(settings.mapStyle, usePrefersDark())
  const styleUrl = dark ? MAP.styles.dark : MAP.styles.light
  const { snapshot } = useStationsSnapshot(systemId)
  const mixedFleet = useMemo(() => !!snapshot && fleetComposition(snapshot.stations) === 'mixed', [snapshot])
  const view: StationView = mode === 'bikes' && settings.preferEbikes && mixedFleet ? 'ebikes' : mode
  // A route option that lets Google Maps pick the streets (Direct) is drawn thin under its road-type colors, so
  // when those can't load it still reads as a preview.
  const preview = BIKE_ROUTING.options[ride.routeIndex]?.handoff === 'docks'
  const { details, pending: colorsPending } = useRouteDetails(systemId, ride.route)
  // With the planner open on a route, only the docks that matter stay on the map: the start dock, the chosen
  // stops and the other docks offered along the route (the planner's own list, so the two never disagree). Mid-ride
  // also the end dock's replacements once it is low or full, and a dock the rider picked (say "Nearest open dock")
  // is always shown. The browse panel shows every dock.
  const panel = useAppStore((s) => s.panel)
  const riding = useRideStore(rideActive)
  const plan = useRidePlan()
  const routeDockKey = useMemo(() => {
    if (panel !== 'ride' || !ride.route || !ride.startId) return null
    const ids = [ride.startId, ...ride.stopIds, ...plan.along.map((d) => d.station.id)]
    const end = plan.end?.station
    if (riding && end && snapshot && endDockState(end, settings.partySize) !== 'ok') {
      ids.push(...replacementDocks(snapshot.stations, end.id, ride.destination?.coord ?? end.coord, settings.partySize).map((r) => r.station.id))
    }
    if (selectedStationId) ids.push(selectedStationId)
    // A string, so a station poll that changes nothing doesn't re-apply the filter.
    return [...new Set(ids)].join('\n')
  }, [panel, riding, ride.route, ride.startId, ride.stopIds, ride.destination, plan.along, plan.end, snapshot, settings.partySize, selectedStationId])
  const routeDockIds = useMemo(() => (routeDockKey === null ? null : routeDockKey.split('\n')), [routeDockKey])
  // The ride up to its end dock and the walks around it (routed once loaded; useRideLines keeps them stable
  // across station polls, so the route isn't re-uploaded every poll).
  const otherRoutes = useMemo(() => ride.routes.filter((r) => r !== ride.route), [ride.routes, ride.route])
  const lines = useRideLines(systemId, plan, ride.route, otherRoutes)
  const endAlong = plan.end?.along
  // Everything the station features depend on: the city (revisions restart at 1 in each city), its data
  // revision, the party size (availability colors), plan roles and stars.
  const stationsKey = snapshot ? `${snapshot.systemId}|${snapshot.revision}|${settings.partySize}|${rolesKey}|${starred.join(',')}` : ''
  // A multi-stop trip's other stops (not the leg on screen's destination, drawn as the destination).
  const { tripStopList, tripLeg } = useTripStore(useShallow((s) => ({ tripStopList: s.stops, tripLeg: s.leg })))
  const tripStops = useMemo(() => (tripStopList.length >= 2 ? tripStopList.filter((_, i) => i !== tripLeg).map((p) => p.coord) : []), [tripStopList, tripLeg])
  // Everything the route layers depend on.
  const routeScene = useMemo(
    () => ({ route: ride.route, routes: ride.routes, destination: ride.destination, origin: ride.origin, segments: details?.segments, track: lines.track, walks: lines.walks, others: lines.others, endAlong, tripStops, preview, pastLegs: ride.pastLegs, colorsPending }),
    [ride.route, ride.routes, ride.destination, ride.origin, details, lines.track, lines.walks, lines.others, endAlong, tripStops, preview, ride.pastLegs, colorsPending],
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
    const { destination } = scene
    // The route appears together with its road-type colors: while those load it isn't drawn (when they can't load,
    // the plain line is). Other route options faded underneath, the chosen one on top — only as far as its end dock.
    const route = scene.colorsPending ? null : scene.route
    const others = route ? scene.routes.filter((r) => r !== scene.route).map((r, i) => ({ ...r, geometry: scene.others[i] ?? r.geometry })) : []
    const chosen = route && scene.track ? { ...route, geometry: scene.track } : route
    const routes = buildRouteFeatures(chosen ? [...others, chosen] : [], others.length, scene.preview)
    // A trip's finished legs, in one muted color, under everything else.
    routes.features.unshift(...buildPastLegFeatures(scene.pastLegs))
    // Walking legs: from a starting place to the pickup dock, and from the end dock to the destination.
    const origin = scene.origin && !scene.origin.stationId ? scene.origin.coord : null
    if (route) routes.features.push(...buildWalkFeatures(scene.walks))
    void source(map, S.route)?.setData(routes as never)
    const segments = route ? (scene.segments ?? []) : []
    void source(map, S.routeKinds)?.setData(buildPathKindFeatures(scene.endAlong !== undefined ? clipSegments(segments, scene.endAlong) : segments) as never)
    void source(map, S.endpoints)?.setData(buildEndpointFeatures(destination?.coord ?? null, origin, scene.tripStops) as never)
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
      if (typeof id === 'string') {
        lastTap.current = { id, atMs: Date.now() }
        emitStation(id)
      } else emitBackground()
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

  // A station opened anywhere but on the map (search, the list, a star, a share link) is brought into view at
  // street level: it was off screen, under the panel, or a dot among the whole city's. A tapped dot is what the
  // rider is looking at, and a camera move someone else just started (Nearest open dock) is left alone. After
  // the city's framing above, so a link to another city's dock isn't framed away.
  const reveal = useEffectEvent((id: string | null, coord: LngLat | undefined) => {
    if (id === null) revealed.current = null
    if (id === null || revealed.current === id || !coord) return // no position yet: once the stations have loaded
    revealed.current = id
    const tap = lastTap.current
    if (tap?.id === id && Date.now() - tap.atMs < 1_000) return
    const map = mapRef.current
    if (!map) pendingCamera.current = { kind: 'fly', center: coord, zoom: MAP.revealZoom }
    else if (!map.isMoving() && (map.getZoom() < MAP.revealZoom || !inView(map, coord, padding.current))) {
      map.easeTo({ center: coord, zoom: Math.max(map.getZoom(), MAP.revealZoom), duration: MAP.revealDurationMs })
    }
  })
  const selectedCoord = selectedStationId ? snapshot?.byId.get(selectedStationId)?.coord : undefined
  useEffect(() => {
    reveal(selectedStationId, selectedCoord)
  }, [selectedStationId, selectedCoord])

  useEffect(() => useLocationStore.subscribe((s) => s.fix, () => drawUser()), [])

  // Wrapper owns positioning: maplibre's CSS sets .maplibregl-map { position: relative } on the inner div.
  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" role="application" aria-label={msg.mapAria} />
    </div>
  )
}
