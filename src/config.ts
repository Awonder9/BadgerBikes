// Single source of tunables, shared by the Worker and the client. Change behavior here, never inline.
// Rationale for most numbers: docs/ARCHITECTURE.md (design review, 2026-11-17).
const env = import.meta.env

const trimSlash = (s: string) => s.replace(/\/+$/, '')

/** Upstream services. Only the Worker calls these; the browser only talks to /api/* and map tiles. */
export const ENDPOINTS = {
  gbfsBase: trimSlash(env.VITE_GBFS_BASE || 'https://gbfs.bcycle.com'),
  valhalla: trimSlash(env.VITE_VALHALLA_URL || 'https://valhalla1.openstreetmap.de'),
  osrmBike: trimSlash(env.VITE_OSRM_BIKE_URL || 'https://routing.openstreetmap.de/routed-bike'),
  osrmFoot: trimSlash(env.VITE_OSRM_FOOT_URL || 'https://routing.openstreetmap.de/routed-foot'),
  photon: trimSlash(env.VITE_PHOTON_URL || 'https://photon.komoot.io'),
} as const

export const APP = {
  name: 'Badger Bikes',
  repoUrl: 'https://github.com/Awonder9/BadgerBikes',
  /** Identifies the app to upstream services (FOSSGIS/Photon usage policies require it). */
  // Forks: change repoUrl (and so this) to your own repository.
  userAgent: 'badger-bikes/0.1 (+https://github.com/Awonder9/BadgerBikes)',
  language: 'en-US',
  /** City used when the rider's approximate location is not near any BCycle system. */
  defaultSystemId: 'bcycle_madison',
} as const

/**
 * Upstream budgets, enforced globally by the UpstreamGate Durable Object (one instance per group).
 * FOSSGIS: "max one request per second" covers BOTH routing hosts together; OSRM /table is not used
 * (6 req/min per IP and each matrix cell counts as a request).
 */
export const UPSTREAM = {
  groups: {
    fossgis: {
      hosts: ['valhalla1.openstreetmap.de', 'routing.openstreetmap.de'],
      minSpacingMs: 1000,
      maxInFlight: 1,
      /** After HTTP 429/503 or repeated network errors: fail fast for this long. */
      circuitOpenMs: 60_000,
    },
    photon: {
      hosts: ['photon.komoot.io'],
      minSpacingMs: 350,
      maxInFlight: 2,
      circuitOpenMs: 30_000,
    },
  },
  /** A queued request not granted a slot within this long is rejected (it is stale by then). */
  queueDeadlineMs: { interactive: 10_000, background: 15_000 },
} as const

export type UpstreamGroup = keyof typeof UPSTREAM.groups
export type Priority = 'interactive' | 'background'

export const HTTP = {
  timeoutMs: 12_000,
  /** Max accepted JSON request body for POST /api/*. */
  maxBodyBytes: 32_768,
} as const

export const CACHE_TTL_MS = {
  stationInformation: 60 * 60_000,
  /** station_status is cached until ~its CDN expiry (lastUpdated + 62 s), clamped to this range. */
  stationStatusMin: 5_000,
  stationStatusMax: 60_000,
  systemInformation: 60 * 60_000,
  route: 10 * 60_000,
  geocode: 24 * 60 * 60_000,
} as const

export const MAP = {
  styles: {
    light: 'https://tiles.openfreemap.org/styles/liberty',
    dark: 'https://tiles.openfreemap.org/styles/dark',
  },
  /** OpenFreeMap serves Noto Sans; MapLibre's default font 404s there. */
  labelFont: ['Noto Sans Bold'],
  labelFontFallback: ['Noto Sans Regular'],
  /** Initial zoom when a system loads without a fit. */
  defaultZoom: 13,
  /** Station dots are small for a finger: a tap this close (px) to one still hits it (the nearest wins). */
  tapSlopPx: 12,
  /** Touch held this long without moving more than longPressMovePx = "choose this point". */
  longPressMs: 500,
  longPressMovePx: 10,
  /** After a long-press pick, the click or contextmenu event the same press may still send is ignored. */
  afterPickIgnoreMs: 800,
} as const

/** Station availability classification (src/lib/stationState.ts). */
export const AVAILABILITY = {
  /** Counts at or below this are "low". */
  lowCountThreshold: 2,
} as const

export const POLL = {
  /** Poll /api/stations right after the feed's CDN entry should have expired. */
  statusAfterFeedMs: 65_000,
  statusMinMs: 10_000,
  statusMaxMs: 65_000,
  /** Cap while navigating or while a StationCard is open. */
  statusActiveMaxMs: 30_000,
  /** Feed older than this is "stale" (badge warns; availability alerts pause). */
  staleAfterMs: 180_000,
  systemDetailsStaleMs: 60 * 60_000,
} as const

/** One speed model for matrices, routes, estimates and the simulator (sent to Valhalla as costing options). */
export const SPEEDS = {
  walkKph: 5.1,
  bikeKph: { classic: 14, electric: 18 },
  /** Straight-line → street-network distance factor for estimates. */
  detourFactor: 1.3,
} as const

/** Bike routing preferences (Valhalla bicycle costing). */
export const BIKE_ROUTING = {
  /**
   * The three route options, left to right. `useRoads` is Valhalla's use_roads (0 = avoid roads with cars as
   * much as possible, 1 = happy on roads). The Fastest option is whichever of the three is quickest.
   */
  options: [
    { key: 'bikeFriendly', label: 'Bike-friendly', useRoads: 0.0 },
    { key: 'balanced', label: 'Balanced', useRoads: 0.35 },
    { key: 'fastest', label: 'Fastest', useRoads: 1.0 },
  ],
  /** use_roads for single bike routes (planner, reroutes). */
  defaultUseRoads: 0.15,
  useLivingStreets: 0.6,
  avoidBadSurfaces: 0.25,
  /** Two routes whose sampled points all lie within this distance of each other are the same route. */
  duplicateRouteMeters: 60,
  /** Valhalla search_cutoff for user-supplied points (stations use the default). */
  userPointSearchCutoffMeters: 500,
} as const

/** Default city from the request's approximate (IP) location — no location prompt. */
export const SYSTEM_DETECT = {
  /** Pick the closest active system whose stations are within this distance of the rider. */
  maxDistanceMeters: 60_000,
  /** Give up and use APP.defaultSystemId after this long. */
  timeoutMs: 3_000,
} as const

/** Rider location (browse accuracy; only after the rider asks). */
export const LOCATION = {
  timeoutMs: 20_000,
  /** Accept a cached position this old (a stationary rider still gets a location). */
  maximumAgeMs: 30_000,
  /** Restart a watch that has been quiet this long after the app becomes visible again. */
  watchdogMs: 15_000,
  /** waitForFix: how long to wait, and how old a known fix may be to reuse it. */
  waitMs: 8_000,
  freshFixMs: 60_000,
} as const

export const GEOCODE = {
  debounceMs: 300,
  /** Direct browser → Photon requests start at least this far apart (politeness on shared campus IPs). */
  directMinIntervalMs: 350,
  /** The rider's position sent to Photon is rounded to this many decimals (~1 km): enough to bias results. */
  biasDecimals: 2,
  /** The browser asks Photon directly (its own IP: fast and not throttled like shared Worker IPs); give up after this and use /api/geocode. */
  directTimeoutMs: 3_500,
  minChars: 3,
  /** Requested from Photon, then de-duplicated down to `keep`. */
  limit: 8,
  keep: 5,
  zoom: 14,
  locationBiasScale: 0.2,
  bboxPadMeters: 2000,
  dedupeMeters: 150,
  reverseRadiusKm: 0.2,
  maxQueryLength: 120,
} as const

export const UI = {
  /** Desktop layout only when wide AND tall, or with a fine pointer that can hover. */
  desktopMinWidthPx: 768,
  desktopMinHeightPx: 600,
  minTouchTargetPx: 56,
  trendSnapshots: 20,
  /** A notice over the map (e.g. "Location is off for this site") hides itself after this long. */
  noticeMs: 6000,
} as const

/** Path breakdown / elevation requests (src/data/routeDetails.ts, POST /api/route-details). */
export const ROUTE_DETAILS = {
  /** The route is thinned to points at least this far apart before sending (the server map-matches it). */
  thinMeters: 8,
  /** Server-side limits on what a client may send. */
  maxPolylineChars: 20_000,
  maxPoints: 5_000,
  /** How long a fetched result stays in the client cache. */
  cacheMs: 30 * 60_000,
} as const

/** Ride plan and ride-in-progress behavior (src/ride/rideStore.ts, src/ui/ride). */
export const RIDE = {
  /** Default for settings.maxRideMinutes: the longest ride between docks the planner plans for. */
  defaultMaxRideMinutes: 25,
  /** Starting from a place: pickup docks considered (with bikes) within this walk, else the nearest few. */
  pickupWalkMeters: 1000,
  pickupCandidates: 3,
  /** Pickup docks with this many bikes or fewer (beyond the party) rank lower by this many seconds. */
  pickupLowBikes: 2,
  pickupLowBikesPenaltyS: 90,
  /** A start this close to its pickup dock needs no walking link. */
  walkLinkMinMeters: 60,
  /** "Walking is about as fast" when walking is within this many seconds of the bike trip. */
  walkComparableSeconds: 120,
  /** Choices offered in Settings; 0 = Unlimited (no re-docks just for time). */
  maxRideChoices: [15, 20, 25, 30, 45, 60, 0],
  /** Within this distance of the destination (with a known location) the ride counts as arrived. */
  arrivedMeters: 100,
  /** Ride timer turns amber this many minutes before the pass's included time runs out. */
  timerWarnMinutes: 5,
  /** The end dock counts as "filling up" at or below this many open docks (plus riders − 1). */
  endDockLowDocks: 1,
  /** Suggested replacement docks: within this distance of the destination. */
  replacementRadiusMeters: 800,
  /** "Try again" stays disabled this long after the route server reported it was busy. */
  busyRetrySeconds: 3,
} as const

/** Google Maps hand-off (src/ride/googleMaps.ts). */
export const GOOGLE_HANDOFF = {
  /** Google Maps mobile links accept at most this many waypoints. */
  maxWaypoints: 3,
  /** No stretch between consecutive Google waypoints may be longer than this (via points are added). */
  maxGuidedGapMeters: 700,
  /** Safety cap on via points for very long rides. */
  maxViaPoints: 12,
  /** Docks within this distance of the route line are sent to Google as the point ON the line. */
  snapToRouteMeters: 60,
} as const
