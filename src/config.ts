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
  /** Weather (no key; free for non-commercial use, attribution "Weather data by Open-Meteo.com", CC BY 4.0). */
  openMeteo: 'https://api.open-meteo.com',
  /** Strava API (rides sent to Strava; the Worker holds the app's client secret). */
  strava: 'https://www.strava.com',
} as const

export const APP = {
  name: 'Badger Bikes',
  repoUrl: 'https://github.com/Awonder9/BadgerBikes',
  /** Identifies the app to upstream services (FOSSGIS/Photon usage policies require it). */
  // Forks: change repoUrl (and so this) to your own repository.
  userAgent: 'badger-bikes/1.0 (+https://github.com/Awonder9/BadgerBikes)',
  language: 'en-US',
  /** City used when the rider's approximate location is not near any BCycle system. */
  defaultSystemId: 'bcycle_madison',
  /** The app's Instagram (Settings and About). Forks: change or set to null to hide the link. */
  instagram: { handle: '@badgerbikes.app', url: 'https://www.instagram.com/badgerbikes.app/' } as { handle: string; url: string } | null,
} as const

/**
 * The iOS and Android apps (Capacitor: capacitor.config.ts, docs/ARCHITECTURE.md §12): this web app bundled into
 * a native shell, loaded from the phone instead of from the deployed site.
 */
export const NATIVE_APP = {
  /**
   * The deployed web app, for a bundle it doesn't serve: the native apps send /api/* requests there and share
   * links point there. Set in `.env.native` (Vite mode "native": `npm run build:native`); empty in the web app,
   * which uses its own origin.
   */
  webOrigin: trimSlash(env.VITE_WEB_ORIGIN || ''),
  /**
   * The origins the apps' web views send (Capacitor's defaults: iOS serves the bundle from capacitor://localhost,
   * Android from https://localhost). The Worker answers cross-origin /api/* requests from these only (CORS).
   */
  origins: ['capacitor://localhost', 'https://localhost'],
  /** How long a web view may reuse a CORS preflight answer (WebKit caps it at 10 min, Chromium at 2 h). */
  preflightMaxAgeSeconds: 7200,
  /** The apps' ID (iOS bundle ID, Android application ID): `appId` in capacitor.config.ts. It can't change once published. */
  appId: 'app.badgerbikes',
  /**
   * Share links open the apps instead of the browser once this site vouches for them (Universal Links, App
   * Links): the Worker serves /.well-known/apple-app-site-association while `appleTeamId` is set and
   * /.well-known/assetlinks.json while `androidCertFingerprints` has an entry. Both files are public by design.
   * `appleTeamId`: the Apple Developer Team ID (10 characters; developer.apple.com → Account → Membership details).
   * `androidCertFingerprints`: SHA-256 fingerprints ("AB:CD:…") of the certificates the Android app is signed
   * with (Play Console → Test and release → App integrity → App signing).
   */
  appleTeamId: '' as string,
  androidCertFingerprints: [] as readonly string[],
  /** iPhone reports the link that launched the app twice (launch URL and event): the same link within this long opens once. */
  repeatedLinkMs: 10_000,
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
    /** One request per city per CACHE_TTL_MS.weather at most (cached); the gate only guards against bursts. */
    openmeteo: {
      hosts: ['api.open-meteo.com'],
      minSpacingMs: 250,
      maxInFlight: 2,
      circuitOpenMs: 60_000,
    },
    /** Strava's limit is per app (STRAVA.rateLimitNote); riders' token exchanges and uploads only. */
    strava: {
      hosts: ['www.strava.com'],
      minSpacingMs: 100,
      maxInFlight: 4,
      circuitOpenMs: 60_000,
    },
  },
  /** A queued request not granted a slot within this long is rejected (it is stale by then). */
  queueDeadlineMs: { interactive: 10_000, background: 15_000 },
  /**
   * A grant never released (its caller vanished) is reclaimed after this long: upstream requests time out after
   * HTTP.timeoutMs (12 s), so a grant held much longer belongs to no one.
   */
  holdTimeoutMs: 30_000,
  /** This many consecutive network/timeout/5xx outcomes open the circuit. */
  circuitErrorThreshold: 3,
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
  /**
   * The GBFS CDN serves station_status with max-age=60: our copy is kept until just after that expires
   * (lastUpdated + this), so a refetch sees the next CDN fill; clamped to stationStatusMin/Max.
   */
  stationStatusAfterFeedMs: 62_000,
  stationStatusMin: 5_000,
  stationStatusMax: 60_000,
  systemInformation: 60 * 60_000,
  route: 10 * 60_000,
  geocode: 24 * 60 * 60_000,
  /** Open-Meteo's current values update every 15 minutes. */
  weather: 15 * 60_000,
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
  /**
   * A station opened from search, the list, a star or a link is brought into view at street level (this zoom)
   * when the map is zoomed out further or the station is off screen or within this many px of the panel or the
   * screen's edge, over this long.
   */
  revealMarginPx: 24,
  revealZoom: 15,
  revealDurationMs: 600,
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
  /**
   * Check for a newly deployed app version this often while the app is open, and whenever it returns to
   * the foreground (a home-screen app on iPhone is resumed, not reloaded, so the load-time check never reruns).
   */
  appUpdateCheckMs: 60_000,
  /** Foreground returns closer together than this don't check again. */
  appUpdateMinGapMs: 30_000,
} as const

/** One speed model for matrices, routes, estimates and the simulator (sent to Valhalla as costing options). */
export const SPEEDS = {
  walkKph: 5.1,
  bikeKph: { classic: 14, electric: 18 },
  /** Straight-line → street-network distance factor for estimates. */
  detourFactor: 1.3,
} as const

/** Route geometry (src/routing/normalize.ts). */
export const ROUTING = {
  /**
   * A requested point farther than this from the router's snapped endpoint is joined to the geometry with a
   * straight connector (RouteLeg invariant in src/types.ts).
   */
  connectorMinMeters: 3,
  /**
   * Routes (POST /api/routes, /api/route, /api/loop, /api/route-details) and reverse lookups (GET /api/reverse) stay
   * within this distance of a city's station area: a destination out of town, a rider already on a bike nearby — never
   * a route across the country, which would make this server a free router in front of the public servers it must spare.
   */
  maxOutsideSystemMeters: 25_000,
} as const

/** Bike routing preferences (Valhalla bicycle costing). */
export const BIKE_ROUTING = {
  /**
   * The route options, left to right; the first is the default. `useRoads` is Valhalla's use_roads (0 = avoid
   * roads with cars as much as possible, 1 = happy on roads). `handoff` is how Google Maps is steered onto it
   * (GOOGLE_HANDOFF): 'docks' = only the docks (Google picks the streets; the line is a preview), 'trails' = plus
   * a point on each trail/path section, 'exact' = plus a point every maxGuidedGapMeters (follows the line, many
   * stops). Direct's useRoads is a first guess at Google's own bike routing — tune it against recorded rides.
   */
  options: [
    { key: 'direct', label: 'Direct', useRoads: 0.5, handoff: 'docks' },
    { key: 'bikeFriendly', label: 'Bike-friendly', useRoads: 0.0, handoff: 'trails' },
  ] as ReadonlyArray<{ key: string; label: string; useRoads: number; handoff: 'docks' | 'trails' | 'exact' | 'loop' }>,
  /** use_roads for single bike routes (planner, reroutes). */
  defaultUseRoads: 0.15,
  useLivingStreets: 0.6,
  avoidBadSurfaces: 0.25,
  /** Two routes whose sampled points all lie within this distance of each other are the same route. */
  duplicateRouteMeters: 60,
  /** Valhalla search_cutoff for user-supplied points (stations use the default). */
  userPointSearchCutoffMeters: 500,
} as const

/** The weather lines (src/ui/browse/WeatherStrip.tsx; data: GET /api/weather, CACHE_TTL_MS.weather). */
export const WEATHER = {
  /** Gusts are mentioned only when they beat the steady wind by at least this much (km/h). */
  gustShowDeltaKph: 8,
  /** Open-Meteo's attribution link (CC BY 4.0). */
  creditUrl: 'https://open-meteo.com/',
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
  /**
   * The iOS/Android apps (native location plugin): high accuracy, or the plugin asks Android 12+ only for
   * approximate location (blurred to about 2 km) and asks iPhones for 3 km accuracy; a new position this often
   * while watching (Android).
   */
  nativeHighAccuracy: true,
  nativeIntervalMs: 5_000,
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
  /**
   * Startup work that can wait — registering the service worker (its precache downloads the whole app, ~2 MB)
   * and fetching the ride planner's code — starts once the first counts and the map have loaded, or at the
   * latest this long after they were first awaited.
   */
  deferredStartMaxMs: 15_000,
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
  /** Most destinations in one multi-stop trip (src/ride/tripStore.ts): legs = stops, each its own ride. */
  maxTripStops: 10,
  /**
   * An end dock farther than this from the route line is reached on the map (and in the GPX file) by a routed
   * last stretch from the line to the dock (POST /api/route), not a straight segment.
   */
  offRouteTailMeters: 60,
  /** "I'm already on a bike": the choices for when the bike was unlocked (minutes ago; 0 = just now). */
  onBikeUnlockedAgoMinutes: [0, 5, 10, 15, 20, 30],
  /** Default for settings.maxRideMinutes: the longest ride between docks the planner plans for. */
  defaultMaxRideMinutes: 25,
  /** Starting from a place: pickup docks considered (with bikes) within this walk, else the nearest few. */
  pickupWalkMeters: 1000,
  pickupCandidates: 3,
  /** Pickup docks with this many bikes or fewer (beyond the party) rank lower by this many seconds. */
  pickupLowBikes: 2,
  pickupLowBikesPenaltyS: 90,
  /** With "Prefer e-bikes", a pickup dock without enough e-bikes for the party ranks lower by this much. */
  pickupNoEbikePenaltyS: 300,
  /** A start this close to its pickup dock needs no walking link. */
  walkLinkMinMeters: 60,
  /**
   * A destination this close to where the ride starts (the start dock, or the rider already on a bike) is not routed:
   * there is nothing to ride, and the routers would only answer "no route".
   */
  minRideMeters: 60,
  /** "Walking is about as fast" when walking is within this many seconds of the bike trip. */
  walkComparableSeconds: 120,
  /** Choices offered in Settings; 0 = Unlimited (no re-docks just for time). */
  maxRideChoices: [15, 20, 25, 30, 45, 60, 0],
  /** Within this distance of the destination (with a known location) the ride counts as arrived. */
  arrivedMeters: 100,
  /**
   * A ride that starts within arrival range of its own destination (a "Just ride" loop back to its dock, a destination
   * right by the start dock) counts as arrived only once the rider has been this far from it — or has ridden for
   * `awayAfterPlannedShare` of the route's planned time, for a page reloaded mid-ride that never saw them leave.
   */
  awayBeforeArrivalMeters: 400,
  awayAfterPlannedShare: 0.5,
  /**
   * Only a position this accurate (meters) can count as arrived: arriving ends the ride, its timer and its background
   * alerts, so a coarse network fix that happens to land near the destination mid-ride must not do it.
   */
  arrivedMaxAccuracyMeters: 75,
  /** Ride timer turns amber this many minutes before the pass's included time runs out. */
  timerWarnMinutes: 5,
  /** "Docked along the way" restarted the timer: Undo is offered this long (an accidental tap would lose the ride time). */
  redockUndoSeconds: 20,
  /**
   * A saved plan whose ride timer started longer ago than this belongs to a ride that ended long ago (the rider
   * never came back to end it in the app): the plan is restored without that ride's progress, instead of
   * reopening on a timer days old.
   */
  maxRideAgeMs: 12 * 60 * 60_000,
  /**
   * A link starting at a dock opened this soon after "Docked along the way" is the same unlock: the claimed (earlier,
   * so safer against fees) start is kept instead of restarting the timer again.
   */
  redockLinkGraceSeconds: 180,
  /**
   * The longest plausible included ride time: parsed pass times above it are ignored (they come from text such as
   * "charges may take up to 48 hours" or "24-hour pass"), and the Worker refuses it in a ride's alerts.
   */
  maxIncludedMinutes: 600,
  /** The end dock counts as "filling up" at or below this many open docks (plus riders − 1). */
  endDockLowDocks: 1,
  /**
   * A "Just ride" loop back to its start dock: its end dock isn't watched (in the app, or by the server's alerts) for
   * this long after the timer starts. The live feed takes a few minutes to show the docks the party's own bikes just
   * freed there, and a full start dock is a common place to begin — it would read as "end dock full" at once.
   */
  loopEndWatchDelayMs: 4 * 60_000,
  /** Suggested replacement docks: within this distance of the destination. */
  replacementRadiusMeters: 800,
  /** "Try again" stays disabled this long after the route server reported it was busy. */
  busyRetrySeconds: 3,
} as const

/**
 * Background ride alerts (Web Push): the Worker's RideAlerts Durable Object sends "time almost up", "past your
 * included time" and "end dock full" while Google Maps is in front (worker/rideAlerts.ts).
 */
export const PUSH = {
  /**
   * Push services the Worker sends to (Chrome/Android, Firefox, Safari, Edge on Windows). A subscription whose
   * endpoint is anywhere else is refused, so the Worker can never be pointed at an arbitrary URL.
   */
  endpointHosts: ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'],
  maxEndpointLength: 1024,
  /** How often the end dock is checked during a ride. */
  dockCheckMs: 60_000,
  /** A failed push is retried after this long. */
  retryMs: 30_000,
  /** A ride's alerts stop this long after it was scheduled (or started), whatever happens. */
  maxRideMs: 4 * 60 * 60_000,
  /** The push service drops an alert it couldn't deliver within this long (a stale alert is worse than none). */
  ttlSeconds: 300,
  /** Lifetime of the VAPID token sent to the push service (RFC 8292 allows at most 24 h). */
  vapidTokenSeconds: 12 * 60 * 60,
} as const

/**
 * Anonymous usage counts for the usage dashboard (/analytics; worker/usage.ts). No identifier leaves the
 * device: it keeps only its last active day and last check-in window, and reports "first open today, N days
 * after the previous one" — enough to count unique devices over any window up to `maxGapDays`.
 */
export const USAGE = {
  /** Days and hours are counted in this time zone (BCycle cities are in US time zones). */
  timeZone: 'America/Chicago',
  /** While the app is visible, a device checks in once per window ("active now", activity by hour). */
  beatMs: 5 * 60_000,
  /** Up to 10 s after a window starts, so devices don't all check in at the same instant. */
  beatJitterMs: 10_000,
  /** Gaps between a device's active days are told apart up to this many days (unique users up to 90 days). */
  maxGapDays: 90,
  /**
   * Day records the server keeps; older ones are deleted (the all-time total is kept separately). At least
   * maxReportDays + maxGapDays − 1, so the oldest day of the longest report still has its full 90-day count.
   */
  keepDays: 460,
  /** Most days the dashboard can show (each needs `maxGapDays` before it for its 90-day count). */
  maxReportDays: 365,
  /** What the app counts (each once per use). */
  events: ['ride_start', 'gpx', 'share', 'nearest_dock', 'nearest_bike', 'directions', 'alerts_on'],
  /** What the Worker counts itself. */
  /** `dashboard_views`: the /analytics page opened (its first request; refreshes and range changes don't count). */
  serverCounters: ['routes', 'routes_busy', 'alerts_sent', 'dashboard_views'],
} as const

/** Google Maps hand-off (src/ride/googleMaps.ts). */
export const GOOGLE_HANDOFF = {
  /** Google Maps mobile links accept at most this many waypoints. */
  maxWaypoints: 3,
  /** 'exact' hand-off: no stretch between consecutive Google waypoints may be longer than this (via points are added). */
  maxGuidedGapMeters: 700,
  /** 'trails' hand-off: trail/path sections shorter than this get no point (Google rarely skips them). */
  trailMinMeters: 400,
  /** 'trails' hand-off: a trail section gets one point per this many meters (at least one). */
  trailPointEveryMeters: 2000,
  /** 'trails' hand-off: trail sections less than this apart are one section (a trail crossing a street). */
  trailJoinGapMeters: 80,
  /** 'trails' hand-off: no point this close to a dock stop or the ride's ends (the dock already anchors it). */
  trailNearStopMeters: 200,
  /** Safety cap on via points for very long rides. */
  maxViaPoints: 12,
  /** Docks within this distance of the route line are sent to Google as the point ON the line. */
  snapToRouteMeters: 60,
  /**
   * 'loop' hand-off ("Just ride"): a loop has no destination for Google to aim at, so it is steered by a via point
   * at least every this many meters (fewer taps than 'exact', still the loop's shape).
   */
  loopGuidedGapMeters: 1_600,
} as const

/**
 * "Just ride" (src/routing/loop.ts, POST /api/loop): a ride with no destination, of a chosen length, along bike
 * trails and past scenic places (OpenStreetMap via Overpass), back to the start dock or ending at another dock.
 */
export const LOOP = {
  /** Ride-time choices (minutes); the default is the rider's pass's included time when it is one of these. */
  minuteChoices: [15, 20, 30, 45, 60, 90],
  defaultMinutes: 30,
  /** Valhalla use_roads for loops: as far from car traffic as the network allows. */
  useRoads: 0,
  /** Street-network meters per straight-line meter between loop waypoints (sizes the loop before routing). */
  detourFactor: 1.3,
  /** A routed loop more than this far off the wanted length (fraction) is re-planned once, rescaled. */
  lengthTolerance: 0.3,
  /** Most routing attempts for one loop (each is one request to the public routing server). */
  maxAttempts: 2,
  /** Scenic points considered per waypoint (best scored, then picked with the seed). */
  candidatesPerPick: 30,
  /** Synthesized waypoints (no scenic point fits) may snap this far to a street or path. */
  viaSearchCutoffMeters: 1_500,
  /** A scenic place within this distance of the routed line is listed as a highlight. */
  highlightMeters: 120,
  maxHighlights: 5,
  /** One-way rides end at a dock with space this far (fraction of the straight-line length) from the start, or more. */
  oneWayMinEndFraction: 0.35,
  /** POST /api/loop accepts at most this many via points, each within maxRadiusMeters of the start. */
  maxVia: 3,
  maxRadiusMeters: 30_000,
} as const

/**
 * OpenStreetMap trail + scenery data for loops (src/routing/scenic.ts), generated at build time by
 * scripts/update-scenic.mjs (Node can't import this file: the script mirrors these values, and its test keeps them equal).
 */
export const SCENIC = {
  /** The city's station box is padded by this much for the query (loops leave the station area). */
  bboxPadMeters: 4_000,
  /** Overpass's own time limit for the query (seconds); OVERPASS_TIMEOUT_S overrides it for a big city. */
  queryTimeoutSeconds: 25,
  /** Trail lines are sampled into candidate waypoints this far apart. */
  sampleEveryMeters: 350,
  /** Most candidate points kept per city (best scored), so the generated file stays small. */
  maxPoints: 4_000,
  /** A trail point this close to water, inside a park, or near a viewpoint counts as scenic. */
  waterMeters: 150,
  viewpointMeters: 300,
  /** Score added per feature (a plain trail point scores 1). */
  score: { water: 2, park: 2, viewpoint: 3, namedRoute: 1 },
} as const

/** Ride history on this device and its weekly / monthly / yearly reviews (src/history). */
export const HISTORY = {
  /** Most rides kept; the oldest are dropped. */
  maxRides: 2_000,
  /** Only the newest this many rides keep their route line (for Strava and the review map); stats need none. */
  maxRidesWithLine: 300,
  /** A saved route line is thinned to points at least this far apart. */
  lineThinMeters: 20,
  /** A ride that ended sooner than this after it started was a mis-tap, not a ride: it isn't kept. */
  minRideSeconds: 60,
  /**
   * The ride's end isn't seen (the app wasn't open when the rider docked): when the app learns the ride is over more
   * than (planned time × this + slack) after it started, the planned time is used instead, marked as estimated.
   */
  lateEndFactor: 1.75,
  lateEndSlackMs: 15 * 60_000,
  /** Weeks start on Monday (ISO). */
  weekStartsOn: 1,
  /** The yearly review is offered from this month (0-based: 11 = December) of the year it covers through January. */
  yearlyFromMonth: 11,
  /** Days into a new week / month that the review of the one just ended is offered on the home panel. */
  weeklyOfferDays: 3,
  monthlyOfferDays: 7,
  /** Car emissions avoided per km ridden instead of driven (US EPA average passenger vehicle: ~400 g CO2 per mile). */
  co2KgPerKm: 0.25,
  /** Riding effort (MET) for the calories estimate, and the body weight it assumes. */
  met: { classic: 6.8, electric: 4.0 },
  assumedWeightKg: 70,
  /** "Your rides" lists this many rides at a time ("Show more" adds as many again). */
  listPageSize: 100,
  /** Story card auto-advance in the review. */
  storyCardMs: 6_000,
  /** A press on a story card shorter than this is a tap (next / previous card); a longer one only pauses it. */
  storyTapMaxMs: 350,
} as const

/**
 * Sending rides to Strava. The Worker exchanges and refreshes tokens with the app's client secret (Worker secrets
 * STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET; without them the feature is hidden) and forwards uploads; the rider's
 * tokens stay on their device. New Strava apps accept only their owner until Strava raises their athlete capacity.
 */
export const STRAVA = {
  scope: 'read,activity:write',
  /** The access token is refreshed when it expires within this long. */
  refreshBeforeMs: 5 * 60_000,
  /** Upload status checks: Strava asks for at most one a second; processing takes ~2 s on average. */
  pollEveryMs: 1_500,
  maxPolls: 20,
  /** Largest GPX file accepted for forwarding (a long ride's track is far smaller). */
  maxGpxBytes: 400_000,
  /** OAuth `state` older than this is refused. */
  stateMaxAgeMs: 15 * 60_000,
  activityUrl: 'https://www.strava.com/activities/',
  /** Strava's brand orange, required for "View on Strava" links. */
  brandColor: '#FC5200',
  maxNameLength: 120,
  maxDescriptionLength: 1_000,
} as const
