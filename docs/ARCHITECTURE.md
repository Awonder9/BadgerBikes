# Badger Bikes — Architecture (v2)

Status: **v2** (2026-11-18). v1 had an in-app turn-by-turn navigation engine and a walk–bike–walk trip
planner; both were removed when navigation moved to Google Maps. Code contracts live in `src/types.ts`,
`src/config.ts` (every tunable), `src/api/contract.ts`, `src/routing/types.ts`, `src/store/types.ts`,
`src/map/types.ts` and `src/lib/upstream.ts`. When this document and a contract file disagree, the contract
file wins; fix the doc.

---

## 1. Product scope

A mobile-first web app (installable PWA, also packaged as iOS and Android apps — §12) for BCycle riders in any
BCycle city. The first visit picks the
city nearest the rider (`GET /api/stations?system=nearest`, from Cloudflare's city-level request location —
no permission prompt; `APP.defaultSystemId` = Madison when none is within `SYSTEM_DETECT.maxDistanceMeters`),
in the same request that loads that city's stations; Settings → City switches it (the current ride plan is
cleared, since it belongs to the old city's stations).

1. **Live station map**: bikes and open docks, auto-refreshed, freshness badge, Bikes/Docks toggle
   (*E-bikes* with *Prefer e-bikes* in cities with both kinds), accessible station list (also the fallback
   without WebGL2), *Nearest open dock* (where can I return this bike?), an offline banner. A launch screen
   covers the app until the first live snapshot arrives (Retry / Continue if BCycle is unreachable).
2. **Station card**: status banner, live counts with trend, ~walk estimate, *Start ride here* / *Ride to
   here*, walking *Directions* (Google Maps), *Share*, a *BCycle* button (app hand-off), *Watch this
   station*, star.
3. **Ride planner** (§7): start dock (search, map tap, or *Nearest dock with bikes*) with its e-bike/classic
   mix → destination (search, map tap, quick chips for saved and recent places) → three route options
   (*Bike-friendly*, *Balanced*, *Fastest*) → docks along the route (preselected, uncheck to skip) →
   Google Maps links (split into parts) + a walking link.
4. **Ride in progress**: parts opened are tracked ("Next: Part 2 → dock"), ride timer against the pass's
   included minutes (the planner asks for the pass on the first ride in a city), end-dock watch with nearby
   replacement docks, alerts in the app and — Web Push from the Worker — in the background while Google
   Maps is in front, a banner back to the plan. The plan and progress persist on the device until the last
   link (walk, or last ride part) is opened or the rider arrives, because switching to Google Maps can
   reload the page.
5. **Share a ride**: link with start dock, destination and route option (Web Share or clipboard).
6. **Search**: local station match + Photon places; saved places (Home/Work/starred) and recents (clearable
   in Settings).
7. **First-visit tip**: how to add the app to the home screen (iOS Safari / Android Chrome), shown once (never
   in an installed app or the native apps).
8. **About**: attributions, operator contact, "Report a map problem".

**Non-goals**: unlocking bikes or accounts (the official BCycle app does that), turn-by-turn guidance
(Google Maps does that), fare calculation, offline maps, accounts/sync (saved data is device-only).

---

## 2. System overview — where code runs

```
Browser (React app, static assets on Cloudflare)       Cloudflare Worker (/api/*)                       Upstreams
 ├─ map rendering (maplibre-gl 6, OpenFreeMap tiles) ──────────────────────────────────────────────────▶ tiles.openfreemap.org
 ├─ UI, stores, polling /api/stations             ─▶  stations / system  ──▶ two-tier cache ──────────▶ gbfs.bcycle.com (CDN)
 ├─ search box (debounced)                        ─▶  geocode / reverse  ──▶ UpstreamGate(photon) ─────▶ photon.komoot.io
 ├─ ride planner                                  ─▶  routes (3 options) ──▶ router ─▶ UpstreamGate(fossgis) ─▶ valhalla1 / routing.openstreetmap.de
 └─ Google Maps links (built on device, no API key) ─────────────────────────────────────────────────▶ google.com/maps (rider's app)
```

- **Worker**: upstream access, caching, global rate limiting, GBFS normalization, routing, reverse geocoding.
- **Place search** is the one exception: the browser asks Photon directly (`api.geocode`). Photon throttles by
  IP and Cloudflare Workers share outgoing IPs, so through the Worker about a third of searches failed (HTTP
  521/502) or stalled in the gate queue. The rider's own IP is fast (~0.3–0.6 s) and reliable; on failure or
  after `GEOCODE.directTimeoutMs` the client falls back to `/api/geocode`. CSP `connect-src` allows
  photon.komoot.io.
- **Device**: map, UI, docks-along-route selection, Google Maps link building, ride progress.
- **Usage dashboard** (`/analytics`, `analytics.html` + `src/analytics/`): a separate page and bundle that
  nothing in the app links to or loads; see §8a.
- **Native apps** (`ios/`, `android/`, Capacitor; §12): the same React bundle in the platform's web view, loaded
  from the phone. It calls the deployed Worker cross-origin; the Worker answers CORS for the apps' origins only.
- **Shared pure modules** (`src/lib`, `src/data/gbfs.ts`, `src/geocode/photon.ts`, `src/routing`, `src/ride`
  except `rideStore.ts`) are runtime-agnostic: no DOM, no Node APIs, injected clocks. `tsconfig.worker.json`
  (no DOM lib) checks everything the Worker imports.

---

## 3. External services (verified 2026-11-17)

| Service | Use | Facts that shape the code |
|---|---|---|
| BCycle GBFS (`gbfs.bcycle.com/{system}/{feed}.json`, GBFS 1.1) | stations | Fetch feed URLs directly (no discovery). Booleans `0/1` (1.1) or `true/false` (2.1) → `v === true \|\| v === 1`. Timestamps epoch **seconds** → ms at the boundary. `num_bikes_available_types {classic, smart, electric}` on every station; `smart` always 0 (ignored). `last_reported` == feed time (ignored). No `capacity`. `Cache-Control: public, max-age=60` (CloudFront; query strings ignored — never cache-bust). Names may have trailing spaces and `&`. `rental_uris` 301 to a Revolution marketing page (BCycle rebranded to Revolution, June 2026) — use `system_information.rental_apps` (`bcycle://` + store links) instead. Pricing `url` lacks a scheme. Seasonal systems can list 0 stations (bcycle_truckee); some systems have 1–2 stations. |
| Valhalla (FOSSGIS, `valhalla1.openstreetmap.de`) | routes, text | Primary for everything routing. `units` (`miles`/`kilometers`) changes lengths AND spoken text. Shape = polyline **precision 6**, decodes to [lat, lon] → swap. Maneuvers share boundary indices; arrive has begin == end. `verbal_transition_alert_instruction` has **no distance** and often equals the pre text. Default `search_cutoff` is 35 km (silently snaps a lake pin 1.6 km away). Errors: HTTP 400 `{error_code}` — 170 unconnected, 171 no edges near location, 154 distance limit (bike 150 km), 442 no path. |
| OSRM (FOSSGIS, `routing.openstreetmap.de/routed-{bike,foot}`) | **route-only** fallback | **Never use `/table`** (6 req/min per IP, burst 1, each cell counts as a request). HTTP 200 can carry `code != 'Ok'` (treat as error). Steps carry no text and no shape indices; arrive step geometry is degenerate. `radiuses` for user points; never send hints. |
| Photon (`photon.komoot.io`) | search, reverse | `bbox` hard filter (`minLon,minLat,maxLon,maxLat`), `zoom=14`, `location_bias_scale=0.2`, `limit=8` then de-dup to 5. `extent` is `[minLon, maxLat, maxLon, minLat]`. Empty reverse → "Dropped pin". Fair use; extensive use gets throttled. |
| OpenFreeMap (`tiles.openfreemap.org/styles/{liberty,dark}`) | tiles | Fonts: **Noto Sans Regular/Bold/Italic only** (MapLibre's default font 404s). Attribution comes from TileJSON — keep the attribution control on. |

**Usage policies (must comply):** FOSSGIS = at most 1 request/second **for both hosts combined**, no heavy use,
valid User-Agent identifying the app, attribution "© OpenStreetMap contributors" + link to
`https://www.openstreetmap.org/fixthemap`, and an **easily reachable operator email** on the site (Worker var
`CONTACT_EMAIL` = badgerbikes.app@gmail.com, sent in the User-Agent and shown in About). High-traffic sites may not use FOSSGIS — a public
launch should point `VITE_VALHALLA_URL`/`VITE_OSRM_*` at self-hosted or commercial Valhalla-compatible
endpoints (the code supports this via env).


---

## 4. Worker (`worker/`)

**Endpoints** (`src/api/contract.ts`): `GET /api/health`, `GET /api/meta`, `GET /api/stations?system=`
(`system=nearest` on a first visit: the nearest city's stations — the response's `systemId` names the city —
so the launch screen waits for one request, not a city lookup and then the stations),
`GET /api/system?system=`, `GET /api/locate` (nearest city; the client's fallback if that first request
fails), `POST /api/routes` (three bike route options), `POST /api/route-details`
(path breakdown + elevation), `GET /api/geocode?q=&system=[&lat=&lon=]`,
`GET /api/reverse?lat=&lon=`, `POST /api/push/ride` and `POST /api/push/cancel` (background ride alerts;
404 when the deployment has no VAPID keys — `/api/meta` then reports `pushPublicKey: null`),
`POST /api/usage` and `GET /api/analytics?days=` (anonymous usage counts and the dashboard, §8a). Errors:
`{ error: { code, message, retryable } }` with 4xx/5xx; codes from `AppErrorCode`.

- Validate everything: `system` must match a registry id; coordinates finite and in range; strings trimmed
  and length-limited; body ≤ `HTTP.maxBodyBytes`. Unknown fields ignored.
- Per-client-IP limits via Rate Limiting bindings (`ROUTE_LIMITER`, `GEOCODE_LIMITER`, `PUSH_LIMITER`);
  exceeded → 429 `rate_limited`.
- Responses: JSON, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, same-origin only.

**Upstream layer (`worker/upstream.ts`)**: cache (per-isolate LRU, then the Cache API) → `UpstreamGate`
Durable Object per group (`interactive > background` priority, ≥ `minSpacingMs` between request starts,
≤ `maxInFlight`, queue deadlines, circuit breaker on 429/503 or repeated errors; a denial is
`upstream_unavailable`) → fetch with `APP.userAgent` + contact email → cache with TTL. The gate's logic is
a pure core (`worker/gateCore.ts`) tested in Node; `worker/gate.ts` is the thin Durable Object. Work the
response doesn't wait for runs under `ctx.waitUntil`: Cache API writes (the in-isolate copy is stored at
once) and gate releases (a lost release would hold FOSSGIS's single slot until the 30 s reclaim).

**Capacity**: FOSSGIS allows ~1 request/second for the whole site, and one `/api/routes` call makes three
Valhalla requests. When the gate or the servers refuse, the route options would degrade to straight-line
guesses, which are useless for finding docks — so `/api/routes` returns 503 `upstream_unavailable` instead
and the planner shows "Route server busy … try again in a few seconds" with a short countdown
(`RIDE.busyRetrySeconds` = 3). Already-computed options are cached, so the retry is cheap.

**Static asset headers** (`public/_headers`): CSP (`connect-src 'self' https://tiles.openfreemap.org`, …),
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`,
`Permissions-Policy: geolocation=(self), camera=(), microphone=()`; `/assets/*` (content-hashed names) is
`Cache-Control: public, max-age=31536000, immutable` (Cloudflare's default is `max-age=0, must-revalidate`).

---

## 5. Data (`src/data`, `src/geocode`, `scripts/update-systems.mjs`)

- `normalizeStationInformation`: trim names; `coord = [lon, lat]`; drop invalid/0,0 coords; `hasKiosk =
  _bcycle_station_type === 'Kiosk and Station'`. `region_id` and `rental_uris` are not passed on (unused; they
  were about half of every `/api/stations` response).
- `normalizeStationStatus`: counts as non-negative integers; `ebikes/classic` from `num_bikes_available_types`
  or `null` when absent; flags via `toBool`; `lastUpdatedMs = last_updated × 1000`.
- `mergeStations`: info order; status `null` when missing. `buildSnapshot` builds `byId`.
- `normalizeSystemDetails`: `rental_apps` → `AppLink`s, phone/email/url, passes with
  `parseIncludedMinutes` (first `/(\d+)\s*-?\s*min/` in description, else `/(\d+)\s*-?\s*hour/ × 60`, else
  name; "per minute" only → null), normalized https URLs, `defaultIncludedMinutes` = smallest non-null.
- Stations classification (`src/lib/stationState.ts`): `bikeState`/`dockState` ∈ `ok|low|none|unavailable`;
  low ≤ 2 (+ party size − 1); unavailable = `!isInstalled` or not renting (bikes) / not returning (docks).
  `fleetComposition` hides the classic/e-bike split for single-type fleets.
- Registry generator (`npm run update-systems`): drop non-200 systems; 0-station systems keep the previously
  committed bbox/center and get `active: false`; `center` = station medoid. `nearestSystem()` picks the
  default city (§1).
- Photon: build labels (`name ?? "housenumber street" ?? street ?? city`; detail = address if a name was used,
  plus city/locality), de-dup same `name|street|city` within 150 m, bias = user position when inside the
  system bbox else the system center, `bbox` = station bbox padded 2 km.


---

## 6. Routing (`src/routing`)

**Valhalla requests**: `costing: 'bicycle'` with `{ bicycle_type: 'City', cycling_speed, use_roads,
use_living_streets, avoid_bad_surfaces }` (`BIKE_ROUTING`); `directions_options: { units, language }`.
User-supplied destinations get `search_cutoff: BIKE_ROUTING.userPointSearchCutoffMeters`.

**Route options** (`routeLadder`): one route per `BIKE_ROUTING.options` level — Bike-friendly
(`use_roads` 0), Balanced (0.35), Fastest (1.0) — in that order. The Fastest slot is replaced by the
quickest of the three, so the label is always true; identical options are kept (positions are labels)
and the UI marks them "Same as …".

**Normalization** (both providers satisfy the `RouteLeg` invariants in `src/types.ts`): lengths → meters;
polyline6 → `[lon, lat]`; connectors when snapped > 3 m; duplicate points removed; Valhalla maneuver types →
`ManeuverKind` (street names are used to find trail sections, §7). `POST /api/routes` leaves out Valhalla's
spoken-instruction text (`verbal*`, unused since navigation moved to Google Maps; `routeForApp` in `worker/app.ts`).

**Fallbacks**: Valhalla → OSRM route (never `/table`) → straight line. `route()` rejects only with `aborted`
or `location_unroutable`; `routeLadder()` also rejects with `upstream_unavailable` when any option is a
straight-line estimate (§4).

---

## 7. Ride planning and the Google Maps hand-off (`src/ride`, `src/ui/ride`)

**Start from anywhere** (`pickup.ts`): the start (`ride.origin`) is a place or a dock. From a place, up to
`RIDE.pickupCandidates` docks with bikes within `RIDE.pickupWalkMeters` are ranked by estimated walk +
estimated ride to the destination (+ a penalty for nearly empty docks); the best is used until the rider
picks one (`pickupPinned`). It is chosen only before routing, so live count changes never re-route a plan
on screen. Walk legs (to the pickup, from the end dock, and "walk straight there") are straight-line
estimates (`estimateBetween`), shown with "~", drawn as dashed lines, with Google walking links. Opening the
first ride part does not start the ride timer when there is a walk to the dock first; the ride card asks
"I've unlocked a bike".

**Path breakdown + elevation** (`details.ts`, `POST /api/route-details`): one Valhalla `/trace_attributes`
request for the selected route only (polyline6 of our geometry, `shape_match: walk_or_snap` because of the
dock connectors, background priority, cached), classifying each edge by `use` / `cycle_lane` /
`road_class` into bike path → shared-use path → protected lane → bike lane → shared lane → quiet street →
road with traffic, and summarizing `mean_elevation` (3 m dead band) into climb/descent and a profile.
With `shape` + `edge.begin/end_shape_index` it also returns the route as same-kind segments, drawn as the
colored line on the map (`PATH_COLORS` in `src/map/colors.ts`, shared with the breakdown legend). The
planner card and the map share one cached request (`src/data/routeDetails.ts`).

**Docks along the route** (`stationsAlongRoute.ts`): only docks on the route line (≤ 50 m) are offered, in
ride order. Two labeled exceptions add an off-route dock: a re-dock option (≤ 300 m off the line) when a
stretch would exceed the rider's max ride time (`settings.maxRideMinutes`, default
`RIDE.defaultMaxRideMinutes` = 25, 0 = unlimited) without one, and the dock closest to the destination when
the last on-route dock is more than a 400 m walk away. `optimizedStops` preselects the fewest docks that keep
every ride within the limit (greedy: re-dock at the farthest usable dock still in range), ending at the
usable dock closest to the destination; the rest are shown as optional stops. Ride times use the chosen
route's pace (duration ÷ distance) so they match the route cards. The last checked dock ends the ride. The
list is recomputed from live counts, but the stops already chosen always stay in it (`keepIds`): a chosen
dock that fills up stays the end of the ride and is reported as full (with a usable alternative listed),
instead of silently dropping out of the plan and its Google links.

**Google Maps links** (`googleMaps.ts`, Maps URLs, no API key): a link carries only an origin, a destination
and ≤ 3 waypoints (mobile), and Google picks its own path between them. To keep it on the chosen route:
- docks within `GOOGLE_HANDOFF.snapToRouteMeters` of the line are sent as the point on the line (a dock on a
  side street makes Google loop around the block); the end dock keeps its real location;
- via points are added so no stretch exceeds `GOOGLE_HANDOFF.maxGuidedGapMeters`, using the fewest points,
  placed on trail/cycleway sections where that costs no extra point (Google turns a coordinate into the
  nearest address or business, so a point mid-trail anchors best);
- the result is split into parts of ≤ 3 waypoints, ending a part at a dock when possible; each part records
  where it ends and whether it starts at a dock. A walking link covers dock → destination.

**Exact-route file** (`gpx.ts`): the alternative to the Google links. One GPX 1.1 track from the start
dock along the chosen route to the end dock (cut where the line passes it, or ending at the dock itself
when it is off the line), plus waypoints for the start, every dock and the destination; all text
XML-escaped. Shared through the Web Share API when the browser accepts .gpx files, else downloaded; Komoot
("Stick to original route") and OsmAnd ("Navigate → Follow track") then navigate it turn by turn. Using it
starts the ride like opening the Google parts (and finishes the saved plan when there is no walk link).

**Ride store** (`rideStore.ts`, zustand + `persist`): start, destination, route options, chosen option,
stops, opened parts and ride start time, saved to `localStorage` (`bcycle.ride`) and validated on restore
(`restoreRide`). `finishPlan()` stops saving it — called when the rider opens the trip's last link (the
walk, or the last ride part) or arrives within `RIDE.arrivedMeters` of the destination (checked only when
location permission was already granted; the app never prompts for this). Changing the start, destination
or route option clears progress and saves again; changing the stops keeps it (mid-ride, a rider switching to
another dock — say the end dock filled up — keeps the ride timer and background alerts). Opening a part that
starts at a dock (the rider unlocks a bike there) restarts the ride timer.

**Ride in progress** (`rideProgress.ts` pure; `useRideStatus.ts`, `RideProgress.tsx`): timer vs the pass's
included minutes (warn at `RIDE.timerWarnMinutes`), end dock `ok | low | full` for the party, replacement
docks with space within `RIDE.replacementRadiusMeters` of the destination (each with a Google Maps link from
the rider's position), one-shot alerts (vibration + system notification if permitted, shown through the
service worker's `showNotification` because Android Chrome refuses `new Notification()`; tapping one focuses
the app via `public/sw-notifications.js`). Mid-ride, a dock tapped on the map opens its card (it never
replaces the destination, which would also clear the ride timer and opened parts); *Nearest open dock* is on
the ride card too. The first ride in a city asks which pass the rider has (only when its passes include
different times; `passChoiceMatters`), so the timer warns at the right moment.

**Background ride alerts** (Web Push; `src/ui/ride/backgroundAlerts.ts`, `worker/rideAlerts*.ts`,
`worker/webPush.ts`): a web page cannot run while Google Maps is in front, so while a ride is under way and
notifications are allowed, the client subscribes to push (VAPID key from `/api/meta`) and sends the Worker
the ride's start, the pass's included minutes, the end dock, party size and language (`POST /api/push/ride`,
re-sent whenever one changes; `POST /api/push/cancel` when the ride ends). A `RideAlerts` Durable Object per
subscription (named by the endpoint's SHA-256) wakes on alarms: "almost up" at `RIDE.timerWarnMinutes`
before the included time, "past your included time" when it runs out (only "over" once both are due), and
"end dock full" from a check of the live feed every `PUSH.dockCheckMs`; each once per ride (re-registering
the same ride repeats nothing). The text comes from the app's messages in the rider's language — never from
the request. Messages are encrypted per RFC 8291 (aes128gcm) and authorized with VAPID (RFC 8292) using
WebCrypto only, tested against the RFC 8291 Appendix A vectors; `TTL` `PUSH.ttlSeconds`, `Urgency: high`, a
`Topic` per alert. 404/410 from the push service deletes the ride; other failures retry after
`PUSH.retryMs`; everything is deleted at the latest `PUSH.maxRideMs` after the ride started. Pushed and
in-app alerts share notification tags (`ALERT_TAGS`), so one replaces the other. Without push the in-app
alerts still work. The ride card's alerts section (`src/ui/ride/AlertsHelp.tsx`, rules in `alertsGuide.ts`)
tells the rider what this phone needs: on iPhone in a Safari tab, the Add to Home Screen steps (tabs can't
receive web push; the Home Screen app keeps its own storage, so the ride is planned there); on Android, to
allow Chrome's notifications too if Android asks; once blocked, how to allow them again (Android tab,
installed Android app, iPhone Settings); in an Android browser without notifications, to use Chrome. It never
promises background alerts when the server has no VAPID keys.

**Share links** (`src/lib/urlParams.ts`): `?system=<id>&start=<station id>&to=<lat,lon>&toName=&toStation=&route=<0-2>`,
validated on load, applied to the ride store (replacing any saved plan; a link to another city switches it
like Settings → City), then removed from the address bar.

---

## 8. Client UI (`src/ui`, `src/map`, `src/store`, `src/location`, `src/data/hooks.ts`)

- **Layout**: MapView mounted once. Desktop side panel for wide screens; otherwise full-screen map + bottom
  sheet (peek/half/full in `svh`, so the on-screen keyboard never resizes it; "full" stops below the map
  buttons). `h-dvh`, safe-area insets.
- **Map**: maplibre-gl (with its CSS) is imported only by `src/map/maplibre.ts`, which sets the worker URL
  and is loaded on demand: `src/map/MapView.tsx` imports maplibre's types only and starts the dynamic import
  when the app starts, so the ~1 MB library never delays the first paint or the first station request (a
  static import of anything in maplibre-gl elsewhere would pull it back into the startup bundle). Until the
  map exists, the MapApi keeps padding and the latest camera request and applies them on creation. Station
  source with `promoteId: 'id'`; mode toggle changes paint only; the station features are re-uploaded when
  the city, data revision, party size, plan roles or stars change; chosen route on top of faded alternatives;
  start/stops/end rings; selection via feature-state (re-applied after a style reload); user location dot
  from `useLocationStore` (outside React). The theme follows the OS (`prefers-color-scheme`) live; the style
  is only reloaded when it actually changes. Taps hit the nearest station dot within 12 px; a long press
  (touch timer or the browser's contextmenu) picks a point once. While planning, a tapped dock fills the
  planner (start, then destination) instead of opening the station card.
- **Location** (`src/location/locationStore.ts`): watched only after the rider asks (Locate, Nearest dock,
  "My location" search); asking again after an error (denied, unavailable) starts a new watch, and Locate
  says why when there is no position. `waitForFix()` for one-shot needs: a fresh fix, else the next one, else
  (on timeout) the last known position.
- **Stores**: `useAppStore` (persisted: settings, saved/starred/recent places — device-only, explained in
  Settings), `useRideStore` (§7), `useLocationStore` (never persisted).
- **Refresh**: the home panel's *Refresh* button refetches station counts immediately (BCycle itself
  publishes about once a minute, so that is the freshest possible).
- **Data hooks**: `useStationsSnapshot` polls `/api/stations` (`cache: 'no-store'`) after the feed's CDN
  expiry, refetches on focus, keeps the last data on error, tracks `revision`/`changedIds`; it has no timers
  (many always-mounted components use it) — the freshness badge ages on its own clock. The first request
  starts before React's first render (`prefetchStations` in `App.tsx`). `/api/system` is requested only
  where it is shown or once a route exists (pass minutes), not at startup.
- **Re-renders**: nothing ticks app-wide. Clocks (`useNow`) live in leaf components and pause when unused:
  the ride clock only while a ride timer runs, the launch screen's only while it is up; ride alerts, the
  arrival check and the station watch are leaf components of `AppShell`. `useRidePlan` memoizes each
  derivation and shares the docks-along-route computation across its callers.
- **Map while planning**: once a route is shown, only the start dock and the docks along the route (the
  selectable stops) stay on the map; other docks are filtered out until you leave the planner.
- **Prefer e-bikes** (`settings.preferEbikes`, offered only when `fleetComposition` is `mixed`): the Bikes
  view counts e-bikes (`ebikeState` / `ebikes` feature properties; the toggle reads *E-bikes*), pickup
  ranking adds `RIDE.pickupNoEbikePenaltyS` for docks without enough e-bikes, and planner estimates use
  e-bike speeds (`ridesElectric`), as they already did for all-electric fleets. Route requests are unchanged.
- **Nearest open dock** (`useNearestOpenDock`, home panel and ride card): the rider's position →
  `nearestOpenDock` (closest dock where the party can return, any distance) → docks view, its card open.
- **Offline banner**: `navigator.onLine` (`useOnline`); it shares a stack under the map buttons with the
  ride banner. React Query refetches the counts on reconnect.
- **Launch screen**: a static copy in `index.html` (inline CSS, no JavaScript) paints as soon as the page
  arrives; `LoadingScreen.tsx` replaces it on the first render with the same layout (status lines reserve two
  lines in every language, so nothing shifts) and stays until the first snapshot; the install tip waits for it.
- **Startup order**: the first station request leaves before React renders; maplibre and the ride planner
  (`RidePlannerPanel`, its own chunk) load on demand. Work that can wait starts once the first counts are in and
  the map has drawn (`src/map/mapSettled.ts`), or `UI.deferredStartMaxMs` at the latest (`AfterStartup` in
  `AppShell.tsx`): the service worker is registered then — its precache (~2 MB) would otherwise download the map
  runtime a second time alongside the page on a first visit; registered later it reads those files from the
  HTTP cache — and the planner's code is fetched in the background.
- **Search**: place search (the public geocoder) runs only for text the rider typed, never for a prefilled
  name, a picked result or "My location".

---

## 8a. Usage counts and the dashboard (`src/ui/usage.ts`, `worker/usage*.ts`, `src/analytics/`)

**Goal**: how many people use the app (unique users today / 7 / 30 / 90 days and all time, active now) and
how, without tracking anyone. **No identifier leaves the device**, and nothing stored can tell devices apart.

- The device keeps only `{ day, window }` (its last active day in `USAGE.timeZone` and its last check-in
  window) in localStorage. It sends `POST /api/usage`: `open` once per page load (after the city is known),
  `beat` once per `USAGE.beatMs` window while visible (other tabs skip a claimed window), and `event` for a
  few feature uses (`USAGE.events`; a ride start is the first Google Maps link / walk / GPX of a ride). With
  its first open or check-in of a day it adds `first`: the **gap in days since its previous active day**
  (null = new device), city, platform, installed or not, language.
- **Unique users from gaps**: a device active in the window [S, E] is counted once, on its first active day d
  in the window, where its gap > d − S. So per day the server keeps a histogram of gaps (1 … 90, the last
  bucket "90 or more") and any window up to `USAGE.maxGapDays` is a sum (`uniqueUsers` in
  `worker/usageCore.ts`), exact — a 400-device simulation checks it against true distinct counts. All-time
  users is a running total of new devices.
- **Active now**: check-ins in the current window, or the previous window while the current one fills.
  Riders in Google Maps aren't counted until they return to the app (the page can't run then).
- The Worker counts `routes` (route options served), `routes_busy` (the busy routing server asked the rider
  to retry) and `alerts_sent` itself.
- Storage: one `Usage` Durable Object (SQLite, KV API): `d:YYYY-MM-DD` day records, `window`, `total`. Days
  older than `USAGE.keepDays` are deleted. No IP, User-Agent, location or identifier is stored.
- Not counted: Do Not Track / Global Privacy Control on, `navigator.webdriver` (automation, tests),
  bot-like User-Agents (server side), browsers without working site storage. Settings → storage note says so.
- **Dashboard** at `/analytics`: public by URL (anonymous totals only), `noindex` (meta + `X-Robots-Tag`),
  not linked from the app, not precached by the app's service worker (`globIgnores`, and
  `navigateFallbackDenylist` so the app shell never answers it). `GET /api/analytics` is rate-limited and
  cached per Worker isolate for 30 s. Charts are hand-made SVG (`src/analytics/charts.tsx`): stacked columns
  (new vs returning), lines (7/30-day uniques; routes vs rides), hour-of-day activity, ranked bars
  (cities, devices, installed, languages, features); every chart has a table view and keyboard scrubbing.

---

## 9. Security

- Launch params: `system`, station and ride ids match `^[A-Za-z0-9_.-]{1,80}$`; coordinates validated;
  names stripped of control characters and angle brackets; params removed with `history.replaceState`.
- Persisted state (app and ride stores) is validated piece by piece; failures fall back to defaults.
  Storage only through `src/lib/storage.ts` (never throws).
- Untrusted strings rendered only as React text / maplibre text-field; no `innerHTML`. External links through
  `safeExternalUrl` with host allow-lists. App hand-off (one "BCycle" button, `appLaunchUrl`): iOS opens BCycle's App Store page
  in the App Store app (`itms-apps://`, shows Open/Get) because the BCycle app no longer answers
  `bcycle://`; Android launches the app by package (`intent://` launcher intent) with the Play Store as fallback.
- Web Push: the Worker only sends to https endpoints on known push services (`PUSH.endpointHosts`, no
  credentials or ports), so a subscription can't aim it at an arbitrary URL; keys are checked for the exact
  P-256/16-byte shapes; times must be plausible. The alert text is generated server-side from the app's
  messages and the official station feed, so nobody can make the Worker send their own text. The VAPID
  private key is a Worker secret. Stored per ride: the push subscription, language, city, end dock, party
  size and ride timer — no location — until the ride ends, the subscription is gone, or 4 hours pass.
- Usage counts (§8a) carry no identifier; reports are validated field by field (known kinds, events,
  platforms, languages; gap 1–90) and rate-limited per IP. Anyone can post fake counts — the usual limit of
  client-side analytics — but never text: the dashboard only renders numbers and names from fixed tables.
- CORS: `/api/*` sends `Access-Control-Allow-Origin` (and answers preflights) only for the native apps' web-view
  origins, `NATIVE_APP.origins` (`capacitor://localhost`, `https://localhost`); every other origin gets no CORS
  headers, as before. The API uses no cookies or credentials, so this only lets those web views read responses
  that any non-browser client could already fetch.

---

## 10. Testing

- Vitest `unit` (Node) for `src/**/*.test.ts` and `worker/**/*.test.ts`; `dom` (jsdom) for `*.test.tsx`.
  Real captured responses in `src/test/fixtures/` (see its README); builders in `src/test/factories.ts`.
- Key suites: GBFS normalize/merge, pricing parse, Photon, Valhalla/OSRM normalizers (RouteLeg invariants),
  router fallbacks and the busy rejection, route options, docks along the route, Google link building
  (snapping, via points, part splitting, labels), ride store persistence/progress, ride timer and end-dock
  watch, nearest open dock, URL params, gate core, worker endpoints (incl. the first-visit nearest city).
- Native apps (§12): CORS for the apps' two origins only, preflights and errors included (`worker/worker.test.ts`);
  telling the app from a browser tab, and offering the GPX file only where its web view can share it
  (`src/ui/platform.test.ts`); the alerts guide's native case. No automated tests run the apps themselves: build
  them with `npm run ios` / `npm run android`.
- Background alerts: Web Push encryption against the RFC 8291 test vectors and decrypted as a browser would,
  the VAPID JWT verified with WebCrypto (`worker/webPush.test.ts`); the RideAlerts rules and the Durable
  Object end to end with fake storage and the captured Madison feed (`worker/rideAlerts.test.ts`); the
  browser hook's ordering (registers once the plan is known; a ride ended mid-registration is cancelled
  after it — `src/ui/ride/backgroundAlerts.test.tsx`); the service worker's push/click handlers run against a
  fake `self` (`src/ui/ride/serviceWorkerAlerts.test.ts`).
- Usage counts: the unique-user math against a 400-device simulation, the Usage object with fake storage
  (`worker/usage.test.ts`); what the browser sends and when, DNT/GPC (`src/ui/usage.test.tsx`); day and gap
  helpers across DST (`src/lib/usage.test.ts`); the dashboard's range numbers (`src/analytics/aggregate.test.ts`).
- E2E (Playwright, phone + desktop, network-free with inline `/api/*` mocks): launch screen (slow and
  failing feed), install tip, default city + City setting, shared ride link with a busy route server, plan saved
  across a reload until the last link is opened, station card Directions/Share, Nearest open dock, offline
  banner, Prefer e-bikes + clearing recents, the first-ride pass question and the path-details retry, the
  alerts help on Android and iPhone (and the planner's iPhone hint), the `/analytics` dashboard, and that
  the app has no link to it.

---

## 11. Deployment & operations

Cloudflare Workers + static assets (`wrangler.jsonc`, custom domain badgerbikes.app). `npm run deploy`
builds and runs `wrangler deploy`; `npm run cf-typegen` after changing bindings. Background ride alerts need
the secrets `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (`npm run vapid-keys` makes a pair; each deployment its
own); without them `/api/meta` reports no push key and the client keeps to in-app alerts. Usage counts need
nothing to set up (the `Usage` Durable Object comes with the deploy); the dashboard is at `/analytics`. Free plan limits are ample
(I/O-bound requests). For heavier traffic than FOSSGIS allows, point `VITE_VALHALLA_URL` / `VITE_OSRM_*` at a
self-hosted or commercial Valhalla-compatible service. PWA: `registerType: 'prompt'`, no runtime caching of live data. When a new version is deployed, a
"Refresh" prompt stays on screen until the rider taps it (no "Later"), so nobody keeps running an old
version against a changed API. It waits while a ride is in progress (a Google Maps part or the walk to
the dock has been opened) and appears once the ride ends. The app asks the service worker to check for a new version on every return
to the foreground and every `POLL.appUpdateCheckMs` while open (`src/ui/layout/appUpdateChecks.ts`): an
installed app on iPhone is resumed rather than reloaded, so the browser's own load-time check would not run.
The native apps (§12) call the deployed Worker, so a Worker change they depend on (such as their CORS) has to be
deployed before builds that need it reach phones, and the API must keep answering older app versions, which
update only through the stores.

---

## 12. Native apps (Capacitor: `capacitor.config.ts`, `ios/`, `android/`)

The iOS and Android apps are this web app in a native shell (Capacitor 8): the same React bundle runs in the
platform's web view (WKWebView, Android System WebView), loaded from the phone instead of from the site.

- **Build**: `npm run build:native` = `tsc -b` + `vite build --mode native` + `cap sync`. Native mode
  (`vite.config.ts`) builds into Capacitor's `webDir` (`<system temp>/bcycle-live-native`, outside the
  cloud-synced folder like the web build) without the Cloudflare plugin (no Worker build, and
  `.wrangler/deploy/config.json` is left alone, so a native bundle can't be deployed by mistake), without the
  service worker and web manifest (`VitePWA({ disable })` turns `useRegisterSW` into a no-op, so the update prompt
  never shows; app updates come from the stores), and without the usage dashboard. `cap sync` copies the bundle
  into `ios/App/App/public` and `android/app/src/main/assets/public` (both gitignored). `npm run ios` /
  `npm run android` build, then open Xcode / Android Studio. iOS uses Swift Package Manager (no CocoaPods).
- **Server**: nothing serves `/api/*` next to the bundle, so the apps call the deployed site:
  `NATIVE_APP.webOrigin`, from `VITE_WEB_ORIGIN` in `.env.native` (committed: `https://badgerbikes.app`;
  `.env.native.local` overrides it, e.g. `http://localhost:5173` for a simulator against `npm run dev`). A native
  build without a valid origin fails. In the web app it is empty, so `apiUrl` (`src/api/client.ts`) keeps URLs
  relative. Share links use the same origin (`shareOrigin()`), because the page's own origin is the phone.
- **CORS**: iOS serves the bundle from `capacitor://localhost`, Android from `https://localhost` (Capacitor's
  defaults; `server.*` stays unset). Every API request is therefore cross-origin, and the JSON POSTs need a
  preflight: the Worker answers both origins (`NATIVE_APP.origins`, `worker/app.ts`, §9), errors included so the
  app can read their codes. The dev server leaves CORS to the Worker (`server.cors: false`), as production does.
  Saved places, settings and the ride plan live in that origin's storage, separate from the browser's.
- **Telling the app apart**: `isNativeApp()` (`src/ui/platform.ts`) reads `window.Capacitor`, which the native
  bridge defines before the page runs, so the web bundle needs no `@capacitor/core`. The app counts as installed
  (`isStandalone()`): no install tip and no "Add to Home Screen" alert steps.
- **What the web view has** (iOS, checked in the simulator 2026-11-19): no Notification API, Push API or service
  worker, and no `navigator.vibrate` on iOS. So the alerts guide says `appOnly` (alerts while the app is open) and
  background alerts are off. Web Share with files works on iOS (the GPX export opens the share sheet); Android's
  web view has neither Web Share nor downloads, so the GPX export is hidden there (`canHandOverFiles()`).
  Location is the page's `navigator.geolocation`: the iOS purpose string is in `Info.plist`
  (`NSLocationWhenInUseUsageDescription`), the Android permissions in `AndroidManifest.xml` (Capacitor asks for
  them when the page first asks for a position, never at launch). Links to other sites (`target="_blank"`, Google
  Maps) leave the web view: Capacitor hands them to the system, which opens the Google Maps app when installed.
- **Look**: Android draws edge to edge with `env(safe-area-inset-*)` set as in a browser
  (`SystemBars.insetsHandling: 'native'`; the page already pads itself, `viewport-fit=cover`). The native launch
  screens, the web view's background and the page's launch screen share its teal gradient, so launching shows no
  flash. Icons and launch images are rendered from the app's artwork by `scripts/generate-icons.mjs`.
- **Identity**: `appId` `app.badgerbikes` (iOS bundle ID, Android application ID) and the name Badger Bikes;
  the store identity can't change once published.
- **Not built yet**: native notifications (local notifications for the ride timer, which need no server; APNs/FCM
  from the Worker for "end dock full"), share links opening the app (universal links / app links), the Android
  back button closing panels, haptics on iPhone, the GPX file on Android (a native share plugin), store listings.
  Untested: the Android app (no Android SDK on the machine that set it up), and whether iOS adds WebKit's own
  "localhost would like to use your location" prompt after the system one (if it does, the Geolocation plugin
  avoids it).
- **Cloud-synced folder**: Gradle writes `android/app/build`, `android/build` and `android/.gradle` inside the
  project (gitignored, but OneDrive syncs them). They stay there because `cap run android` reads the APK from
  `android/app/build`. Xcode's build products and Swift packages go to DerivedData, outside the project.
