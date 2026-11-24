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
   here*, walking *Directions* (Google Maps), *Share*, *Street View* (`streetViewUrl`: a Maps URL that opens
   Google's panorama nearest the dock; no API key), a *BCycle* button (app hand-off), *Watch this station*, star.
3. **Ride planner** (§7): start dock (search, map tap, or *Nearest dock with bikes*) with its e-bike/classic
   mix, or *I'm already on a bike* (plan from the rider's position, timer running) → destination (search, map tap, quick chips for saved and recent places) → two route options
   (*Direct*: Google Maps picks the streets between docks, the line is a preview; *Bike-friendly*: Google is
   held to its trails by a few waypoints) → docks along the route (preselected, uncheck to skip) →
   Google Maps links (split into parts) + a walking link.
4. **Ride in progress**: parts opened are tracked ("Next: Part 2 → dock"), ride timer against the pass's
   included minutes (the planner asks for the pass on the first ride in a city), end-dock watch with nearby
   replacement docks, alerts in the app and — Web Push from the Worker; in the iOS/Android apps, the timer's
   alerts scheduled on the phone (§12) — in the background while Google Maps is in front, a banner back to the
   plan. The plan and progress persist on the device until the last
   link (walk, or last ride part) is opened or the rider arrives, because switching to Google Maps can
   reload the page.
5. **Share a ride**: link with start dock, destination and route option (Web Share or clipboard).
6. **Search**: local station match + Photon places; saved places (Home/Work/starred) and recents (clearable
   in Settings).
7. **First-visit tip**: how to add the app to the home screen (iOS Safari / Android Chrome), shown once (never
   in an installed app or the native apps).
8. **About**: attributions, operator contact, "Report a map problem", the app's Instagram (`APP.instagram`; also a
   row in Settings; null hides both).
9. **Weather** (`WeatherStrip`, home panel and planner): the city's temperature and conditions, feels-like, wind
   with direction (gusts when they beat it by `WEATHER.gustShowDeltaKph`), and today's sunrise/sunset in the
   city's time zone — from `GET /api/weather` (Open-Meteo, for the city's center: nothing about the rider is
   sent), refreshed every `CACHE_TTL_MS.weather`; hidden until it loads or when it can't.
10. **Just ride** (§7b): a ride with no destination, of a chosen length, along trails and past scenic places, back
    to the start dock or ending at another dock.
11. **Your rides** (§8b): the rides started from plans, recorded on the device, with weekly / monthly / yearly
    reviews as story cards.
12. **Send to Strava** (§8c): a recorded ride as a Strava activity (opt-in; the planned route, said so).

**Non-goals**: unlocking bikes or accounts (the official BCycle app does that), turn-by-turn guidance
(Google Maps does that), fare calculation, offline maps, accounts/sync (saved data, ride history included, is
device-only; Strava is an export the rider starts, not a sync), recording GPS tracks (the page can't run while
Google Maps is in front).

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
  Location, notifications, share links opening the app, the back button and the GPX file use Capacitor plugins
  (`src/native/`), loaded on demand and only inside the apps.
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
| Open-Meteo (`api.open-meteo.com/v1/forecast`) | weather | No key; free for non-commercial use, attribution "Weather data by Open-Meteo.com" (CC BY 4.0, shown under the weather and in About). Asked for the **city's center** in its IANA zone (`timezone`, so sunrise/sunset are the city's day) with `timeformat=unixtime`; metric units (the client converts). Errors: HTTP 400 `{error, reason}`. Gate group `openmeteo`; cached `CACHE_TTL_MS.weather` (its current values update every 15 min). |
| Overpass API (`overpass-api.de`, at build time only) | trails + scenery for Just ride | Queried by `npm run update-scenic` (one query per city, 5 s apart, never by the app or Worker): the public instance asks for < 10,000 queries/day, no parallel queries, a User-Agent, and backing off on 429/504 (it also answers 502 when overloaded: the script retries after 30 s). Output: `src/data/scenic/<system>.json` (ODbL, "© OpenStreetMap contributors"). Big cities can time out at 25 s (`OVERPASS_TIMEOUT_S`); `OVERPASS_URL` selects another instance. |
| Strava API (`www.strava.com`) | Send to Strava | OAuth 2 (authorization code); exchange **and refresh need the client secret** (no PKCE) → Worker. Access tokens last 6 h; every refresh returns a new refresh token (the old one stops working). Upload: multipart `file` + `data_type=gpx`, `sport_type` (`Ride` / `EBikeRide`), `external_id`; **every GPX point needs a `<time>`**. Async: poll `GET /uploads/{id}` (≤ 1/s; ~2 s typical); `error` "… duplicate of activity N". 401 = revoked. Limits per app: 200 requests / 15 min, 2,000 / day; new apps accept only their owner until their athlete capacity is raised (10) or reviewed (more). Brand rules: "Connect with Strava" links to its authorize page; "View on Strava" bold in #FC5200. |
| OpenFreeMap (`tiles.openfreemap.org/styles/{liberty,dark}`) | tiles | Fonts: **Noto Sans Regular/Bold/Italic only** (MapLibre's default font 404s). Attribution comes from TileJSON — keep the attribution control on. |

**Usage policies (must comply):** FOSSGIS = at most 1 request/second **for both hosts combined**, no heavy use,
valid User-Agent identifying the app, attribution "© OpenStreetMap contributors" + link to
`https://www.openstreetmap.org/fixthemap`, and an **easily reachable operator email** on the site (the
`CONTACT_EMAIL` Worker secret, sent in the User-Agent and shown in About). High-traffic sites may not use
FOSSGIS — a public launch should point `VITE_VALHALLA_URL`/`VITE_OSRM_*` at self-hosted or commercial Valhalla-compatible
endpoints (the code supports this via env).


---

## 4. Worker (`worker/`)

**Endpoints** (`src/api/contract.ts`): `GET /api/health`, `GET /api/meta`, `GET /api/stations?system=`
(`system=nearest` on a first visit: the nearest city's stations — the response's `systemId` names the city —
so the launch screen waits for one request, not a city lookup and then the stations),
`GET /api/system?system=`, `GET /api/locate` (nearest city; the client's fallback if that first request
fails), `POST /api/routes` (the bike route options), `POST /api/route` (one leg, only drawn: walks and the
stretch to an off-route end dock; background priority; a straight leg when both routers fail), `POST /api/route-details`
(path breakdown + elevation), `GET /api/geocode?q=&system=[&lat=&lon=]`,
`GET /api/reverse?lat=&lon=`, `GET /api/weather?system=` (the city's weather, §1; geocode rate limit), `POST /api/push/ride` and `POST /api/push/cancel` (background ride alerts;
404 when the deployment has no VAPID keys — `/api/meta` then reports `pushPublicKey: null`),
`POST /api/usage` and `GET /api/analytics?days=` (anonymous usage counts and the dashboard, §8a), `POST /api/loop`
(Just ride: one route through the client's via points, §7b), `POST /api/strava/{token,upload,upload-status,revoke}`
(§8c; 404 without the Strava secrets — `/api/meta` then reports `stravaClientId: null`). Errors:
`{ error: { code, message, retryable } }` with 4xx/5xx; codes from `AppErrorCode`.

- Validate everything: `system` must match a registry id; coordinates finite and in range; strings trimmed
  and length-limited; body ≤ `HTTP.maxBodyBytes` (read as a stream and refused once past it, also without a
  Content-Length). Unknown fields ignored.
- Routes stay within reach of the city (`withinReach`: its station area padded by `ROUTING.maxOutsideSystemMeters`,
  25 km): `/api/routes`, `/api/route` and `/api/loop` refuse ends beyond it with 422 `no_route`, `/api/route-details`
  a line that strays farther than a loop from such a start could (`LOOP.maxRadiusMeters` more); `/api/reverse` names no pin far from every city (`{ place: null }`, no Photon request). A ride
  out of town still plans; a route across the country is never this server's to ask FOSSGIS for. The planner checks
  first (`tooFar`, no request, no Try again) and the app asks no reverse lookup out there.
- Per-client-IP limits via Rate Limiting bindings (`ROUTE_LIMITER` — also `/api/loop` —, `GEOCODE_LIMITER`,
  `PUSH_LIMITER`, `STRAVA_LIMITER`);
  exceeded → 429 `rate_limited`.
- Responses: JSON, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, same-origin only.

**Upstream layer (`worker/upstream.ts`)**: cache (per-isolate LRU, then the Cache API) → `UpstreamGate`
Durable Object per group (`interactive > background` priority, ≥ `minSpacingMs` between request starts,
≤ `maxInFlight`, queue deadlines, circuit breaker on 429/503 or repeated errors; a denial is
`upstream_unavailable`) → fetch with `APP.userAgent` + contact email → cache with TTL. The gate's logic is
a pure core (`worker/gateCore.ts`) tested in Node; `worker/gate.ts` is the thin Durable Object. Work the
response doesn't wait for runs under `ctx.waitUntil`: Cache API writes (the in-isolate copy is stored at
once) and gate releases (a lost release would hold FOSSGIS's single slot until the 30 s reclaim). When the gate
can't be reached, the request still goes out rather than failing the rider, but spaced by the isolate's own
scheduler (`minSpacingMs`), never unthrottled.

**Capacity**: FOSSGIS allows ~1 request/second for the whole site, and one `/api/routes` call makes one
Valhalla request per route option (two). When the gate or the servers refuse, the route options would degrade to straight-line
guesses, which are useless for finding docks — so `/api/routes` returns 503 `upstream_unavailable` instead
and the planner shows "Route server busy … try again in a few seconds" with a short countdown
(`RIDE.busyRetrySeconds` = 3). Already-computed options are cached, so the retry is cheap. When both routers
answered that there is no route at all, retrying can't help: `/api/routes` returns 422 `no_route` and the
planner asks for a destination on a street or path. Other failures are worded by kind too (offline, other;
`rideError`), never shown as the raw technical message. A destination at the start dock, or within
`RIDE.minRideMeters` of where the ride starts, isn't sent to the routers at all: the planner says it is too close
(`tooClose`, no Try again). Already on a bike only the distance from the rider counts (the start dock is just the dock
nearest them, and may be where they ride to).

**Static asset headers** (`public/_headers`): CSP (`connect-src 'self' https://tiles.openfreemap.org`, …),
`Referrer-Policy: strict-origin` (the origin only, also to `/api/*`: a share link's query — a destination's
coordinates — is still in the address bar while the first requests go out), `X-Content-Type-Options: nosniff`,
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

**Route options** (`routeLadder`): one route per `BIKE_ROUTING.options` level, in that order — Direct
(`use_roads` 0.5, the default; a first guess at Google's own bike routing, to be tuned against recorded rides)
and Bike-friendly (0). Each option also names its Google Maps hand-off (§7). Identical options are kept
(positions are labels) and the UI marks them "Same as …". When routes arrive, the option the rider had stays
chosen (a share link's option wins), so a new destination or the next trip leg keeps their choice. A saved plan whose routes don't match the options
(an older app version) is routed again (`restoreRide`).

**Normalization** (both providers satisfy the `RouteLeg` invariants in `src/types.ts`): lengths → meters;
polyline6 → `[lon, lat]`; connectors when snapped > 3 m; duplicate points removed; Valhalla maneuver types →
`ManeuverKind` (street names are used to find trail sections, §7). `POST /api/routes` leaves out Valhalla's
spoken-instruction text (`verbal*`, unused since navigation moved to Google Maps; `routeForApp` in `worker/app.ts`).

**Fallbacks**: Valhalla → OSRM route (never `/table`) → straight line. `route()` rejects only with `aborted`
or `location_unroutable`; `routeLadder()` never returns a straight-line estimate: it rejects with `no_route`
when both routers found no route for an option, else with `upstream_unavailable` (§4).

---

## 7. Ride planning and the Google Maps hand-off (`src/ride`, `src/ui/ride`)

**Already on a bike** (`startOnBike`, *I'm already on a bike* in the planner's start step): the rider picks when
they unlocked the bike (`RIDE.onBikeUnlockedAgoMinutes`), the app finds them once, and the plan starts there:
`bikeAt` is the rider's position (routes are requested from it, `fromIsUserPoint`; the first Google link starts at
it and isn't a dock unlock), the dock nearest it is the plan's start dock (bookkeeping only; `continuingRide`), and
the ride timer starts at the chosen time. A new destination keeps it; changing the start or *End ride* ends it.

**Start from anywhere** (`pickup.ts`): the start (`ride.origin`) is a place or a dock. From a place, up to
`RIDE.pickupCandidates` docks with bikes within `RIDE.pickupWalkMeters` are ranked by estimated walk +
estimated ride to the destination (+ a penalty for nearly empty docks); the best is used until the rider
picks one (`pickupPinned`). It is chosen only before routing, so live count changes never re-route a plan
on screen. Walk legs (to the pickup, from the end dock, and "walk straight there") are straight-line
estimates (`estimateBetween`), shown with "~", with Google walking links. On the map (`useRideLines`), the walks
that get a Google link are drawn dotted along the streets once `POST /api/route` has routed them (one request
each, background priority, cached per leg by React Query — `src/data/legRoutes.ts`), straight until then or
when they can't be routed; walks are drawn above the route lines, which often share their streets. The chosen
route is drawn only up to the end dock (`rideTrack`), its path colors too (`clipSegments`), and the other options
up to where they pass closest to it. An end dock more than `RIDE.offRouteTailMeters` off the line (the dock closest
to a far destination) is reached by a routed bike leg from the line's nearest point (straight until it loads); the
GPX file uses the same leg. Opening the
first ride part does not start the ride timer when there is a walk to the dock first; the ride card asks
"I've unlocked a bike".

**Multi-stop trips** (`tripStore.ts`, `src/ui/ride/TripStops.tsx`): an ordered list of destinations
(`RIDE.maxTripStops`); leg *i* ends at stop *i* and starts at leg 1's start (*i* = 0) or at stop *i − 1* — that
dock when the stop is a dock, else the best pickup near it (*Start from anywhere*). Every leg is its own BCycle
ride: the rider docks near each stop, so legs share no bike, timer or docks. Only the leg on screen is in the
ride store (`planLeg` sets its start and destination as a fresh plan) and is planned exactly like a one-stop
ride — route options, docks along the route and their add/remove all unchanged; the trip store only keeps the
stops, the leg shown, leg 1's start (to come back to it) and the last finished leg. It follows the ride store:
a destination typed for the leg becomes that stop, and clearing the plan (Clear, a share link, a city change)
ends the trip. Editing stops re-plans the leg on screen only when its two ends change; while a ride is under way
(`rideUnderWay`) the edits that would are disabled, as is switching legs.
- **Finishing a leg**: `finishPlan` (its last link opened) or arriving at its stop marks the leg finished; when
  another leg follows, the plan is *not* marked finished (it stays saved, timer included) and arrival doesn't end
  the ride. The planner asks "Finished leg *n* at *stop*?" with *I've docked my bike* (unchecked by default; shown
  only while the ride timer runs). *Finish leg* (`completeLeg`) drops that stop and every earlier one from the
  trip (one stop left: an ordinary ride) and plans the next leg from it. Docked: the timer stops and the leg
  starts like any later leg (that dock, or the best pickup near the stop). Not docked: the rider keeps the bike —
  the leg starts at the stop's dock (or the dock nearest it, only as the route's start: the start card shows
  *On your bike from the last leg* instead of its counts, and can't be changed) and `continuingRide` carries the
  same BCycle ride's timer: re-routing, other route options and a new destination keep it, and opening the leg's
  first link doesn't restart it (a later re-dock does). `rideActive` (ride card, banner, alerts, live counts,
  arrival) includes such a ride before any of the leg's links is opened. *End ride* clears it. Planning a
  finished leg again un-finishes it. Plans from before this (a finished leg not saved) still open on the next
  leg at launch (`reconcileTrip`); a trip that doesn't match the saved plan is dropped. The
trip's other stops are violet dots on the map, and its finished legs stay on it in one muted violet (`ROUTE_COLORS.past`, unused by the path colors)
(`rideStore.pastLegs`: each leg's drawn line, recorded by *Finish leg*; kept when the trip is down to an ordinary
ride, dropped by *Clear* or choosing another leg), under the leg on screen with its path colors. Share links carry the whole trip (below); the GPX file covers the leg on screen.

**Path breakdown + elevation** (`details.ts`, `POST /api/route-details`): one Valhalla `/trace_attributes`
request for the selected route only (polyline6 of our geometry, `shape_match: walk_or_snap` because of the
dock connectors, background priority, cached), classifying each edge by `use` / `cycle_lane` /
`road_class` into bike path → shared-use path → protected lane → bike lane → shared lane → quiet street →
road with traffic, and summarizing `mean_elevation` (3 m dead band) into climb/descent and a profile.
With `shape` + `edge.begin/end_shape_index` it also returns the route as same-kind segments, drawn as the
colored line on the map (`PATH_COLORS` in `src/map/colors.ts`, shared with the breakdown legend). The
planner card and the map share one cached request (`src/data/routeDetails.ts`).

**Docks along the route** (`stationsAlongRoute.ts`): only docks on the route line (≤ 50 m) are offered, in
ride order. Each row shows the ride to it from the previous chosen stop (or the start) — for an optional dock, the
ride it would be if added — its distance off the route, and a Street View link (`streetViewUrl`). Two labeled exceptions add an off-route dock: a re-dock option (≤ 300 m off the line) when a
stretch would exceed the rider's max ride time (`settings.maxRideMinutes`, default
`RIDE.defaultMaxRideMinutes` = 25, 0 = unlimited) without one, and the dock closest to the destination when
the last on-route dock is more than a 400 m walk away — however far off the line, as long as it is closer to the
destination than every dock already listed (past the network's edge, a 1.5 km walk beats a 4.5 km one). A
re-dock option that is also that closest dock is labeled as the dock near the destination (the ride ends there). `optimizedStops` preselects the fewest docks that keep
every ride within the limit (greedy: re-dock at the farthest usable dock still in range), ending at the
usable dock closest to the destination; the rest are shown as optional stops. Ride times use the chosen
route's pace (duration ÷ distance) so they match the route cards; on an e-bike the routes are requested with
`bikeKind: 'electric'`, so that pace is an e-bike's (§8, *Prefer e-bikes*). The last checked dock ends the
ride. The list is recomputed from live counts, but the stops already chosen always stay in it (`keepIds`): a chosen
dock that fills up stays the end of the ride and is reported as full (with a usable alternative listed),
instead of silently dropping out of the plan and its Google links.

**Google Maps links** (`googleMaps.ts`, Maps URLs, no API key): a link carries only an origin, a destination
and ≤ 3 waypoints (mobile), and Google picks its own path between them. Every waypoint is a stop the rider has
to confirm in Google Maps (*Continue*) — Google has no pass-through points — so steering Google costs taps
mid-ride. How much each option steers is its `handoff` (`BIKE_ROUTING.options`):
- docks within `GOOGLE_HANDOFF.snapToRouteMeters` of the line are sent as the point on the line (a dock on a
  side street makes Google loop around the block); the end dock keeps its real location (every hand-off);
- `docks` (Direct): nothing more. Google picks the streets, so the route is a suggestion: the map draws it thin
  and translucent under its road-type colors, and the path details card says it describes the suggested route
  (`pathDetailsSuggested`). On every option the route lines (and walks) are drawn only once the road-type colors
  have loaded, so the line appears in one go; when they can't load, the plain line is drawn;
- `trails` (Bike-friendly): a via point on each trail/path section (`trailPoints`; maneuver street names, see
  `trailRangesOf`) — where Google most likely takes a parallel road instead. Sections under
  `GOOGLE_HANDOFF.trailMinMeters` get none, longer ones one per `trailPointEveryMeters`; sections less than
  `trailJoinGapMeters` apart count as one, and a point within `trailNearStopMeters` of a dock stop is dropped.
  A mid-trail point also anchors best (Google turns a coordinate into the nearest address or business);
- `exact` (not used by an option now; switch one to it in config): via points so no stretch exceeds
  `GOOGLE_HANDOFF.maxGuidedGapMeters`, using the fewest points, on trail sections where that costs no extra
  point. It follows the line closely, at the cost of a stop every few minutes;
- each route card shows its waypoints (`viaPointCount`, counted without docks; called waypoints, not stops, which
  are the docks), and a line under the cards
  explains the chosen option's hand-off with its actual count;
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
location permission was already granted — the app never prompts for this — and only on a position accurate to
`RIDE.arrivedMaxAccuracyMeters`: arriving ends the ride and its alerts, which a coarse fix must not do mid-ride). A ride
that starts within arrival range of its own destination (a loop back to its dock, a destination right by the start
dock) counts as arrived only once the rider has been `RIDE.awayBeforeArrivalMeters` away — or, after a reload that never
saw them leave, has ridden `RIDE.awayAfterPlannedShare` of the route's planned time (not a timer carried over from an
earlier leg): opening the first link at the dock used to end such a ride on the spot. Changing the start, destination
or route option clears progress and saves again; changing the stops keeps it (mid-ride, a rider switching to
another dock — say the end dock filled up — keeps the ride timer and background alerts). Opening a part that
starts at a dock (the rider unlocks a bike there) restarts the ride timer. While a ride is under way the route
options are locked (`routeChoiceLocked`: a link opened, or a timer that isn't a kept bike's): a stray tap on the
other option used to clear the timer and its alerts; ending the ride unlocks them. A saved ride whose timer started
more than `RIDE.maxRideAgeMs` ago (12 h: the rider never came back to end it) is restored without its progress.

**Ride in progress** (`rideProgress.ts` pure; `useRideStatus.ts`, `RideProgress.tsx`): timer vs the pass's
included minutes (warn at `RIDE.timerWarnMinutes`), end dock `ok | low | full` for the party, replacement
docks with space within `RIDE.replacementRadiusMeters` of the destination (each with a Google Maps link from
the rider's position), one-shot alerts (vibration + system notification if permitted, shown through the
service worker's `showNotification` because Android Chrome refuses `new Notification()`; tapping one focuses
the app via `public/sw-notifications.js`). Mid-ride, a dock tapped on the map opens its card (it never
replaces the destination, which would also clear the ride timer and opened parts); *Nearest open dock* is on
the ride card too. While a BCycle ride is under way (`rideUnderWay`: a part opened or the timer started), that
card's *Ride to here* — and a dropped pin's *Ride here* (a long press, or a saved place's marker) — is a Google
Maps bike link from the rider's position, like the replacement docks', instead of a new plan (which would start
from the first dock and clear the timer). The first ride in a city asks which pass the rider has (only when its
passes include different times; `passChoiceMatters`), so the timer warns at the right moment.
- **Docked along the way** (`redockAlongWay`, ride card while a timer runs): the rider docked at a dock the plan
  didn't stop at and took a bike again — say on the bike kept from an earlier trip leg. Only `rideStartedAtMs`
  restarts (now); the leg, its opened links, a kept bike (`continuingRide`) and the trip stay. Every alert follows
  the timer's start (in-app alerts are keyed by it, the Worker treats a new start as a new ride, the apps
  reschedule), so they re-arm. Undo for `RIDE.redockUndoSeconds` (a stray tap would lose the ride time).
  `redockedAtMs` (saved) marks the claim: a link starting at a dock opened within `RIDE.redockLinkGraceSeconds`
  is that same unlock and keeps the claimed, earlier start instead of restarting again; later it is a new ride.

**Background ride alerts** (Web Push; `src/ui/ride/backgroundAlerts.ts`, `worker/rideAlerts*.ts`,
`worker/webPush.ts`): a web page cannot run while Google Maps is in front, so while a ride is under way and
notifications are allowed, the client subscribes to push (VAPID key from `/api/meta`) and sends the Worker
the ride's start, the pass's included minutes, the end dock, party size and language (`POST /api/push/ride`,
re-sent whenever one changes; `POST /api/push/cancel` when the ride ends — through the device's own subscription
when the ride ends after a reload before this page registered it again, say offline). A `RideAlerts` Durable Object per
subscription (named by the endpoint's SHA-256) wakes on alarms: "almost up" at `RIDE.timerWarnMinutes`
before the included time, "past your included time" when it runs out (only "over" once both are due), and
"end dock full" from a check of the live feed every `PUSH.dockCheckMs`; each once per ride (re-registering
the same ride repeats nothing). The text comes from the app's messages in the rider's language — never from
the request. Messages are encrypted per RFC 8291 (aes128gcm) and authorized with VAPID (RFC 8292) using
WebCrypto only, tested against the RFC 8291 Appendix A vectors; `TTL` `PUSH.ttlSeconds`, `Urgency: high`, a
`Topic` per alert. 404/410 from the push service deletes the ride, and so does any other refusal of the request
itself (a 4xx other than 408/429: a malformed message, a key it won't take after the VAPID keys changed), which
retrying can't fix; timeouts, 429 and server errors retry after `PUSH.retryMs`; everything is deleted at the latest
`PUSH.maxRideMs` after the ride started. Pushed and
in-app alerts share notification tags (`ALERT_TAGS`), so one replaces the other. Without push the in-app
alerts still work. The ride card's alerts section (`src/ui/ride/AlertsHelp.tsx`, rules in `alertsGuide.ts`)
tells the rider what this phone needs: on iPhone in a Safari tab, the Add to Home Screen steps (tabs can't
receive web push; the Home Screen app keeps its own storage, so the ride is planned there); on Android, to
allow Chrome's notifications too if Android asks; once blocked, how to allow them again (Android tab,
installed Android app, iPhone Settings); in an Android browser without notifications, to use Chrome. The iPhone
Home Screen steps (planner footer and ride card) have ✕: `settings.alertsHintHidden` hides them there and shows
them in Settings → *Alerts during a ride* instead (`AlertsSettings`, with *Show it in the ride planner again*). It never
promises background alerts when the server has no VAPID keys. The iOS/Android apps have no Web Push: they
schedule the timer's alerts on the phone instead, and "end dock full" shows while the app is open (§12).

**Share links** (`src/lib/urlParams.ts`): `?system=<id>&start=<station id>&stop=…&toName=&to=<lat,lon>&toStation=&route=<0-1>&leg=<n>`.
Names have no whitespace (spaces are written as `_` and read back as spaces; older `+` / `%20` links still
work) and come before coordinates and ids, so chat apps can't split the link at a space or drop a name's
trailing `.`. A multi-stop trip is shared whole: `start` is leg 1's start dock, `to*` stop 1, then one repeated
`stop=lat,lon,<dock id or empty>,<name>` per further stop (`RIDE.maxTripStops`), and `leg` (from 1) the leg shown,
whose route option `route` is; a stop that doesn't parse drops the trip's extra stops. An app without trips
ignores `stop`/`leg` and opens leg 1. A trip whose leg 1 has no start dock yet is shared as the leg on screen. Links are
validated on load, applied to the ride store (replacing any saved plan; a link to another city switches it
like Settings → City), then removed from the address bar. A link never ends a ride under way (`rideUnderWay`, e.g.
a link opened into the app mid-ride): a shared ride's destination opens as a pin instead (its card gives directions
from here and keeps the ride), and a link to another city is left unopened (`openLaunchParams`).

**Just ride** (§7b) routes through via points: `RouteRequest.via` becomes Valhalla `through` locations (no stop or
U-turn there; one leg, so `normalizeValhallaRoute` is unchanged), a synthesized point with a wider `search_cutoff`.
Such a route is Valhalla's or none — OSRM would stop at each point — and the via list is part of the cache key.

---

## 7b. Just ride (`src/routing/loop.ts`, `src/routing/scenic.ts`, `src/data/scenic.ts`, `scripts/update-scenic.mjs`)

A ride with no destination: *Just ride* under *Where to?* (`JustRide.tsx`) sets `rideStore.loop` — minutes
(`LOOP.minuteChoices`; the pass's included time when it is one, else the longest that fits, else 30), round trip
(*Back at this dock*, the default) or one way (*At another dock*), and a seed. A destination of the rider's own ends
it (`setDestination` clears `loop`); a new start keeps it and plans its end again.

- **Scenery** (build time): `npm run update-scenic` asks Overpass once per city (its station box padded by
  `SCENIC.bboxPadMeters`) for cycleways and paths/footways open to bikes — not `mtb:scale`, "mountain bike",
  rough/unpaved surfaces or tracks: BCycle bikes are city bikes —, named parks / nature reserves / gardens / beaches,
  viewpoints, and named water and rivers. Trails are sampled every `SCENIC.sampleEveryMeters`; each point scores 1,
  +1 named, +2 within 150 m of water, +2 in a park's box, +3 within 300 m of a viewpoint, and names its best feature.
  Best `SCENIC.maxPoints` kept; ~5–80 KB per city. Each file is its own lazily loaded `scenery-*` chunk
  (`import.meta.glob`; the service worker leaves them out), loaded the first time a loop is planned in that city — as
  is the loop planner's own code (`loadLoopRoute` imports it on demand; it isn't part of the app's startup code).
- **Waypoints** (`planLoop`, pure, seeded): the target length is `minutes × bike speed`; straight-line size =
  target ÷ `LOOP.detourFactor`. Round trip: a triangle start → A → B → start whose perimeter is that size, A and B
  the best-scored (seed-jittered) scenic points in a ring around the start, leaving at clearly different angles; too
  few points → an equilateral triangle of synthesized points in a seeded direction. One way: an end dock with space
  for the party between `LOOP.oneWayMinEndFraction` and 95 % of the size away, through a scenic point roughly toward
  it; none in range → a round trip, said so (`fellBack`); no scenic point → a point bowing out to one side.
- **Routing** (`loadLoopRoute`): `POST /api/loop` (start → via → end at `LOOP.useRoads` = 0, e-bike speed when the
  rider rides one); a route more than `LOOP.lengthTolerance` off the length is planned once more at a corrected size
  (`LOOP.maxAttempts` = 2 routing requests at most). The route becomes the plan's single route (`routes.length ===
  1`, saved and restored as such), its end dock the destination, and its highlights — named places and trails within
  `LOOP.highlightMeters` of the line (`routeHighlights`) — listed under *Along the way*. *Try another ride* changes
  the seed; a `noRoute` error offers the same.
- **Docks and Google**: a round trip's destination is the start dock, so `docksAlong` ends the list with the start
  dock at the end of the line (instead of skipping it as the start and adding its neighbor as "nearest the
  destination"), and the ride ends there even when that dock is full now (`optimizedFor` counts the docks the party's
  own bikes free: a full dock is where riders find bikes). Its end dock isn't watched for `RIDE.loopEndWatchDelayMs`
  after the timer starts — not in the app, and not by the server (the background alerts are registered without an end
  dock until then): the feed takes minutes to show the bikes just taken, and would read "end dock full" at once. Hand-off `'loop'`: via points at least every `GOOGLE_HANDOFF.loopGuidedGapMeters` (a loop has no
  destination for Google to aim at). A round trip starts at its own destination, so arriving counts only once the rider
  has left (§7, `RIDE.awayBeforeArrivalMeters`). No share link (a link can't express a loop); trips and loops don't mix.

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
  is only reloaded when it actually changes. `usePrefersDark` ignores changes while the page is hidden and
  re-reads the OS setting on every return (`visibilitychange`, `pageshow`, `focus`): iOS flips a backgrounded app
  between light and dark for its app-switcher snapshots and doesn't always report flipping back, which used to
  leave the app (and map) light. Taps hit the nearest station dot within 12 px; a long press
  (touch timer or the browser's contextmenu) picks a point once. While planning, a tapped dock fills the
  planner (start, then destination) instead of opening the station card. A station opened from search, the
  list, a star or a link is brought into view at street level (`MAP.revealZoom`) when it is off screen, under
  the panel or the map is zoomed out further; a tapped dot leaves the camera alone. Attribution links open
  beside the app (the Home Screen app has no browser bar to come back with). A saved place's marker opens its
  place card with the saved name: its spot (Home, Work) is never sent out for a reverse lookup, as a dropped pin's is.
- **Location** (`src/location/locationStore.ts`): watched only after the rider asks (Locate, Nearest dock,
  "My location" search); asking again after an error (denied, unavailable) starts a new watch, and Locate
  says why when there is no position (in the apps: allow it in the phone's settings, `locationProblemText`).
  `waitForFix()` for one-shot needs: a fresh fix, else the next one, else (on timeout) the last known position. A
  position that is none (coordinates out of range or not numbers, no finite accuracy) is dropped (`toGeoFix`).
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
- **Map while planning and riding**: once a route is shown, only the start dock and the docks along the route
  (the selectable stops) stay on the map, also after a Google Maps part is opened; mid-ride the end dock's
  replacements join them once it is low or full, and a dock the rider picked (a tap, *Nearest open dock*) always
  shows. Other docks are filtered out until you leave the planner (the browse panel shows every dock).
- **Prefer e-bikes** (`settings.preferEbikes`, offered only when `fleetComposition` is `mixed`): the Bikes
  view counts e-bikes (`ebikeState` / `ebikes` feature properties; the toggle reads *E-bikes*), pickup
  ranking adds `RIDE.pickupNoEbikePenaltyS` for docks without enough e-bikes, and planner estimates use
  e-bike speeds (`ridesElectric`), as they do for all-electric fleets: the route request carries
  `bikeKind: 'electric'` (Valhalla's `cycling_speed` = `SPEEDS.bikeKph.electric`), because the route cards,
  stop times and re-docks all follow the chosen route's pace. A plan already routed keeps its times until it is
  routed again.
- **Nearest open dock** (`useNearestOpenDock`, home panel and ride card): the rider's position →
  `nearestOpenDock` (closest dock where the party can return, any distance) → docks view, its card open.
- **Nearest bike** (`useNearestStation('bike')`, home panel beside Nearest open dock): the rider's position →
  `nearestBike` (closest dock where the party can rent, any distance) → bikes view, its card open.
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
  (null = new device), city, platform, how it is used (`installed`: the Home Screen web app; `nativeApp`: the
  iOS/Android app, counted by platform; neither: a browser tab), language. `nativeApp` is absent from reports
  by web app versions older than the apps; such reports, and days stored before, count no app use.
- **Unique users from gaps**: a device active in the window [S, E] is counted once, on its first active day d
  in the window, where its gap > d − S. So per day the server keeps a histogram of gaps (1 … 90, the last
  bucket "90 or more") and any window up to `USAGE.maxGapDays` is a sum (`uniqueUsers` in
  `worker/usageCore.ts`), exact — a 400-device simulation checks it against true distinct counts. All-time
  users is a running total of new devices.
- **Active now**: check-ins in the current window, or the previous window while the current one fills.
  Riders in Google Maps aren't counted until they return to the app (the page can't run then).
- The Worker counts `routes` (route options served), `routes_busy` (the busy routing server asked the rider
  to retry) and `alerts_sent` itself.
- **Dashboard views**: the dashboard's first request of a page load carries `view=1`; the Worker counts it
  (`dashboard_views`, a server counter: per day, plus an all-time `dashboardViews` total) before its cache
  answers, not for bot User-Agents. Refreshes and range changes aren't views; no identifier, so views, not viewers.
- Storage: one `Usage` Durable Object (SQLite, KV API): `d:YYYY-MM-DD` day records, `window`, `total`, `dashboardViews`. Days
  older than `USAGE.keepDays` are deleted. No IP, User-Agent, location or identifier is stored.
- Not counted: Do Not Track / Global Privacy Control on, `navigator.webdriver` (automation, tests),
  bot-like User-Agents (server side), browsers without working site storage. Settings → storage note says so.
  The iOS/Android apps count like the web app (their web views send neither signal); the app's storage note
  says it sends anonymous usage counts.
- **Dashboard** at `/analytics`, **website only**: public by URL (anonymous totals only), `noindex` (meta +
  `X-Robots-Tag`), not linked from the app, not precached by the app's service worker (`globIgnores`, and
  `navigateFallbackDenylist` so the app shell never answers it), and never in the iOS/Android apps: their build
  leaves the page out, fails if any of it would be included (`websiteOnlyDashboard` in `vite.config.ts`), and
  `/analytics` links open in the browser (only `/` opens the apps, §12). `GET /api/analytics` is rate-limited and
  cached per Worker isolate for 30 s. Charts are hand-made SVG (`src/analytics/charts.tsx`): stacked columns
  (new vs returning), lines (7/30-day uniques; routes vs rides), hour-of-day activity, ranked bars
  (cities, devices, browser / Home Screen web app / iOS or Android app, languages, features); every chart has
  a table view and keyboard scrubbing.

---

## 8b. Ride history and reviews (`src/history`, `src/ui/rides`, `src/ui/ride/RideRecorder.tsx`)

- **Recording** (`RideRecorder`, mounted only while a ride is under way or a record is open; decisions in the pure
  `recorderStep`): a record starts when a planned ride's timer starts (at the timer's start), follows the plan while it
  is ridden (end dock, route line, path details, highlights), and ends when the ride does. Ended in the app (End
  ride, arriving, the next leg of a trip) → that moment, unless implausibly late (planned time ×
  `HISTORY.lateEndFactor` + slack) → the planned time; the plan simply gone at the next launch (its last link was
  opened, so it wasn't saved) → the planned time; both marked `endEstimated` ("~", correctable in the ride's details).
  Ended within `HISTORY.minRideSeconds` → dropped (a mis-tap). A new plan mid-ride (the next leg on the same bike)
  closes the record and starts one — once the rider set off on the last plan (opened its link, or unlocked a bike for
  it: `active.ridden`); a plan
  replaced before that on the same running timer (already on a bike, then *Try another ride* or another destination)
  was only being planned, and the record follows the new one instead of ending as a ride nobody rode.
- **Storage** (`historyStore`, localStorage `bcycle.history`, validated record by record): newest first, at most
  `HISTORY.maxRides`; only the newest `HISTORY.maxRidesWithLine` keep their route line (polyline6, thinned to
  `HISTORY.lineThinMeters`; needed only for Strava); an open record nobody is recording is dropped on restore. The
  recorder writes only when the record changes (station polls re-run it mid-ride; each write saves the whole history).
- **The rider's control** (Your rides): *Record my rides* (`recording`, saved; off: nothing new is kept and the record
  being written is dropped), *Delete all rides* and *Delete this ride* (each asks first), and the list a page
  (`HISTORY.listPageSize`) at a time, so every kept ride can be reached. The storage notes in Settings name the history.
- **Reviews** (`review.ts`, pure; the device's time zone, calendar days via `src/lib/usage.ts`): weeks Monday–Sunday,
  months, years. Totals, rides per day/month, longest ride, go-to dock and route, docks visited, share on paths and
  protected lanes (rides whose path details were known), climb, time of day, busiest weekday, streak, Just ride
  places, CO₂ avoided (`HISTORY.co2KgPerKm`) and calories (MET × 70 kg), change vs the period before, and a persona
  from the strongest habit. `ReviewStory` plays them as full-screen cards (tap sides / arrows, auto-advance
  `HISTORY.storyCardMs`, a press longer than `HISTORY.storyTapMaxMs` only pauses, Escape or Android's Back closes —
  `openOverlay` in `backButton.ts` —; cards without data are skipped; text share at the end), rendered on the page itself
  (a portal): inside the panel, the ride and offline banners and notices over the map drew on top of it. The home panel offers
  the newest unseen review with rides: the year's in December and January, last month's in a month's first
  `HISTORY.monthlyOfferDays`, last week's in a week's first `HISTORY.weeklyOfferDays`.

## 8c. Send to Strava (`src/history/strava.ts`, `worker/strava.ts`, `src/history/stravaGpx.ts`)

- **Off unless set up**: Worker secrets `STRAVA_CLIENT_ID` (numeric) and `STRAVA_CLIENT_SECRET`; `/api/meta`'s
  `stravaClientId` shows the Strava parts of the app.
- **Tokens**: Strava invalidates a refresh token the moment it issues the next one, so the device refreshes one at a time
  (`freshToken`), first takes newer tokens another tab stored (never older ones: storage that failed to save must not
  roll back), and a refused refresh disconnects only when no other tab refreshed meanwhile; a refresh that lands after
  *Disconnect* is revoked, not kept.
- **Connecting**: *Connect with Strava* → `strava.com/oauth/authorize` (scope `read,activity:write`, a random `state`
  saved on the device) → back to `<site>/?strava=callback&code&state&scope` (the iOS/Android apps claim that link;
  without Universal/App Links set up the code lands in the browser instead, whose storage lacks the app's state, so
  connecting from the apps needs them). The state must match and be under `STRAVA.stateMaxAgeMs`, and the rider must
  have kept "upload activities" ticked; then `POST /api/strava/token` exchanges the code (the Worker adds the client
  secret). Tokens live in localStorage `bcycle.strava`; refreshed within `STRAVA.refreshBeforeMs` of expiry; a 401
  (`unauthorized`) disconnects. *Disconnect* revokes (`/oauth/revoke`, Basic auth with the app's credentials).
- **Sending**: `POST /api/strava/upload` with the ride's line, start and riding time (the rider may correct an
  estimated one first), name, commute flag, `sport_type` (`EBikeRide` on an e-bike) and `external_id`
  `badgerbikes-<ride id>`. The Worker builds the GPX (`stravaGpx`: each point's time spread along the line by
  distance) and **always** appends the note, in the rider's language, that the map is the planned route, not a
  recorded GPS track. The client polls `upload-status` (`STRAVA.pollEveryMs`, at most `maxPolls`); ready or a
  duplicate of an existing activity → the ride remembers the activity id and shows *View on Strava*.

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
- `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` (share links opening the apps,
  §12) are public by design: they name the apps' ID, Apple Team ID and signing-certificate fingerprints, nothing
  secret. Served only once configured; every other `/.well-known/*` path is 404.
- Strava: the client secret is a Worker secret; the Worker stores no tokens or rides, only forwards them. Every
  request carries the rider's token in its body (never a URL), validated as opaque alphanumerics; upload text is
  stripped of control characters and angle brackets and bounded; times must be a plausible past ride; the GPX is
  built server-side (XML-escaped), so no client file is forwarded. OAuth `state` is random, single-use and expires.
  Ride history and Strava tokens stay on the device; a ride goes to Strava only when the rider sends it.
- `POST /api/loop`: at most `LOOP.maxVia` via points, everything within `LOOP.maxRadiusMeters` of the start (no long
  routes through the public router); the client keeps its plans inside that radius however far a second attempt
  rescales them (`maxLoopSize`). Every route request stays within reach of its city (§4).
- Where the rider's location goes: Photon gets the search bias rounded to ~1 km (`GEOCODE.biasDecimals`); route
  requests carry a start or end the rider chose (their position only when they plan from it); the Worker logs
  request URLs without query strings (`observability.redact_query_string` in `wrangler.jsonc`: `/api/reverse` and
  `/api/geocode` carry a pin's coordinates and typed text) and keeps no request bodies; `Referrer-Policy:
  strict-origin` keeps share-link queries out of every Referer. Saved places, recents and the ride plan stay on
  the device, also out of the phone's cloud backups in the apps (§12).

---

## 10. Testing

- Vitest `unit` (Node) for `src/**/*.test.ts` and `worker/**/*.test.ts`; `dom` (jsdom) for `*.test.tsx`.
  Real captured responses in `src/test/fixtures/` (see its README); builders in `src/test/factories.ts`.
- Key suites: GBFS normalize/merge, pricing parse, Photon, Valhalla/OSRM normalizers (RouteLeg invariants),
  router fallbacks and the busy rejection, route options, docks along the route, Google link building
  (snapping, via points, part splitting, labels), ride store persistence/progress, ride timer and end-dock
  watch, nearest open dock, URL params, gate core, worker endpoints (incl. the first-visit nearest city).
- Native apps (§12): CORS for the apps' two origins only, preflights and errors included, and the link files
  (`worker/worker.test.ts`); telling the app from a browser tab (`src/ui/platform.test.ts`); the location plugin
  and its errors (`src/location/geoSource.test.ts`); the timer alerts the apps schedule
  (`src/ride/rideProgress.test.ts`), scheduled even without Android 7's notification channels
  (`src/native/notifications.test.ts`) and kept when the app restarts without the ride
  (`src/ui/ride/nativeRideAlerts.test.tsx`); the alerts guide's native cases; which links open the app, once
  (`src/native/appLinks.test.ts`); the back button (`src/ui/layout/backButton.test.ts`); the BCycle button in
  the Android app (`src/ui/browse/StationCard.test.tsx`); the app ID and link domain agreeing across the native
  projects (`scripts/native-projects.test.mjs`). No automated tests run the apps
  themselves: build them with `npm run ios` / `npm run android` (§12 lists what was checked by hand).
- Background alerts: Web Push encryption against the RFC 8291 test vectors and decrypted as a browser would,
  the VAPID JWT verified with WebCrypto (`worker/webPush.test.ts`); the RideAlerts rules and the Durable
  Object end to end with fake storage and the captured Madison feed (`worker/rideAlerts.test.ts`); the
  browser hook's ordering (registers once the plan is known; a ride ended mid-registration is cancelled
  after it — `src/ui/ride/backgroundAlerts.test.tsx`); the service worker's push/click handlers run against a
  fake `self` (`src/ui/ride/serviceWorkerAlerts.test.ts`).
- Usage counts: the unique-user math against a 400-device simulation, the Usage object with fake storage
  (`worker/usage.test.ts`); what the browser sends and when, DNT/GPC (`src/ui/usage.test.tsx`); day and gap
  helpers across DST (`src/lib/usage.test.ts`); the dashboard's range numbers (`src/analytics/aggregate.test.ts`).
- Just ride: waypoint planning on Madison's generated scenery (`src/routing/loop.test.ts`), the generator's scoring
  and filters (`scripts/update-scenic.test.mjs`), Valhalla `through` locations and no OSRM fallback
  (`src/routing/via.test.ts`), `/api/loop` validation (`worker/worker.test.ts`), the plan in the ride store with a
  captured loop route (`valhalla/route_bicycle_loop.json`).
- Ride history: periods across DST and month/year ends, review numbers and personas, which review to offer, ride
  ends, record validation (`src/history/review.test.ts`); the recorder's decisions (`src/history/recorder.test.ts`).
- Strava: the endpoints with a fake upstream (token exchange with the secret, 401 → `unauthorized`, the GPX and note,
  refusals, upload states, revoke) and the GPX timing (`worker/strava.test.ts`); the OAuth state check and callback
  parsing (`src/history/strava.test.ts`).
- E2E (Playwright, phone + desktop, network-free with inline `/api/*` mocks): launch screen (slow and
  failing feed), install tip, default city + City setting, shared ride link with a busy route server, plan saved
  across a reload until the last link is opened, station card Directions/Share, Nearest open dock, offline
  banner, Prefer e-bikes + clearing recents, the first-ride pass question and the path-details retry, the
  alerts help on Android and iPhone (and the planner's iPhone hint), the `/analytics` dashboard, and that
  the app has no link to it; Just ride (round trip, one way, back to a destination), Your rides with a review story,
  and sending a ride to Strava.

---

## 11. Deployment & operations

Cloudflare Workers + static assets (`wrangler.jsonc`, custom domain badgerbikes.app). `npm run deploy`
builds and runs `wrangler deploy`; `npm run cf-typegen` after changing bindings. Background ride alerts need
the secrets `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (`npm run vapid-keys` makes a pair; each deployment its
own); without them `/api/meta` reports no push key and the client keeps to in-app alerts. "Send to Strava" needs the secrets `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` from a Strava API app whose
Authorization Callback Domain is the site's (§8c); without them it is hidden. Usage counts need
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

## 12. Native apps (Capacitor: `capacitor.config.ts`, `ios/`, `android/`, `src/native/`)

The iOS and Android apps are this web app in a native shell (Capacitor 8): the same React bundle runs in the
platform's web view (WKWebView, Android System WebView), loaded from the phone instead of from the site, with a
few Capacitor plugins where the web view falls short.

- **Build**: `npm run build:native` = `tsc -b` + `vite build --mode native` + `cap sync`. Native mode
  (`vite.config.ts`) builds into Capacitor's `webDir` (`<system temp>/bcycle-live-native`, like the web build) without the Cloudflare plugin (no Worker build, and
  `.wrangler/deploy/config.json` is left alone, so a native bundle can't be deployed by mistake), without the
  service worker and web manifest (`VitePWA({ disable })` turns `useRegisterSW` into a no-op, so the update prompt
  never shows; app updates come from the stores), and without the usage dashboard. `cap sync` copies the bundle
  into `ios/App/App/public` and `android/app/src/main/assets/public` (both gitignored) and registers the plugins
  (`ios/App/CapApp-SPM/Package.swift`, `android/capacitor.settings.gradle`). `npm run ios` / `npm run android`
  build, then open Xcode / Android Studio. iOS uses Swift Package Manager (no CocoaPods).
- **Server**: nothing serves `/api/*` next to the bundle, so the apps call the deployed site:
  `NATIVE_APP.webOrigin`, from `VITE_WEB_ORIGIN` in `.env.native` (committed: `https://badgerbikes.app`;
  `.env.native.local` or the environment overrides it, e.g. `http://localhost:5173` against `npm run dev`). A
  native build without a valid origin fails. In the web app it is empty, so `apiUrl` (`src/api/client.ts`) keeps
  URLs relative. Share links use the same origin (`shareOrigin()`), because the page's own origin is the phone.
  Android refuses plain `http://` (`ERR_CLEARTEXT_NOT_PERMITTED`), so testing the Android app against a local
  Worker also needs `server: { cleartext: true }` while testing, plus `adb reverse tcp:5173 tcp:5173`.
- **CORS**: iOS serves the bundle from `capacitor://localhost`, Android from `https://localhost` (Capacitor's
  defaults; `server.*` stays unset). Every API request is therefore cross-origin, and the JSON POSTs need a
  preflight: the Worker answers both origins (`NATIVE_APP.origins`, `worker/app.ts`, §9), errors included so the
  app can read their codes. The dev server leaves CORS to the Worker (`server.cors: false`), as production does.
  Saved places, settings and the ride plan live in that origin's storage, separate from the browser's, and stay on
  the phone: Android's cloud backup is off (`android:allowBackup="false"`) and iOS leaves the web view's data folder
  (`Library/WebKit`) out of iCloud and computer backups (`AppDelegate.excludeWebViewDataFromBackup`, every launch).
  Android's FileProvider offers only the app's cache folder (`res/xml/file_paths.xml`), where the GPX file is written.
- **Telling the app apart**: `isNativeApp()` (`src/ui/platform.ts`) reads `window.Capacitor`, which the native
  bridge defines before the page runs. The app counts as installed (`isStandalone()`): no install tip and no
  "Add to Home Screen" alert steps. Its usage counts say it is the app (`nativeApp`), so the dashboard tells it
  apart from the Home Screen web app; the dashboard itself is website-only (§8a).
- **Plugins** (`@capacitor/app`, `geolocation`, `local-notifications`, `share`, `filesystem`): imported only in
  `src/native/plugins.ts`, a chunk of its own (~10 KB) loaded by `nativePlugins()` (`src/native/index.ts`) and
  only inside the apps, so the web app never downloads it (like maplibre, §2). The wrappers around them live in
  `src/native/`; the rest of the app calls those, after checking `isNativeApp()`.
- **Location** (`src/location/geoSource.ts`): the plugin, never the web view's `navigator.geolocation`. On iPhone
  the web view's API asks twice — the app's prompt, then WebKit's own "“localhost” Would Like to Use Your Current
  Location", again every day — and only the plugin can tell whether location is allowed without asking (the
  arrival check). It runs with high accuracy (`LOCATION.nativeHighAccuracy`): without it the plugin asks Android
  12+ only for approximate location (blurred to about 2 km) and asks iPhones for 3 km accuracy. Its errors map to
  the app's (`nativeGeoError`; location turned off for the whole phone counts as denied, as in Safari). The iOS
  purpose string is in `Info.plist` (`NSLocationWhenInUseUsageDescription`), the Android permissions in
  `AndroidManifest.xml`; the prompt comes when the app first needs a position, never at launch.
- **Ride alerts** (`src/native/notifications.ts`, `src/ui/ride/nativeRideAlerts.ts`): the web views have no Web
  Push or Notification API, so while a ride's timer runs the app schedules "almost up" and "past your included
  time" on the phone as local notifications (`upcomingTimerAlerts`, the same times the Worker uses:
  `timerAlertTimes`). They arrive while Google Maps is in front without a server, are scheduled again when the
  timer, the pass, the language or the permissions change (fixed ids, `NATIVE_ALERT_IDS`, so a new one replaces
  the old) and are cancelled when the ride ends in the app — not when the app restarts without it: once its last
  link is opened a plan is no longer saved, but the BCycle ride and its alerts carry on, as the Worker's do. While the app is open the scheduled ones show themselves, so the
  in-app alert only vibrates for them; "end dock full" / "filling up" are shown right away from the app, which
  is the only place they can come from (needs the app open). "Turn on alerts" asks for the plugin's permission;
  the alerts guide (`alertsGuide.ts`) says `native` once allowed. Android: since Android 14 exact alarms ("Alarms
  & reminders") are off by default, and an inexact alarm may fire long after its time (the emulator gave the
  25-minute warning a window of +18 min). The plugin would open that settings screen by itself when scheduling;
  the app instead schedules inexact alarms and the ride card offers "Allow alarms & reminders" (`exactAlarms`),
  then schedules them again as exact. Android shows them on the high-importance channel `ride-alerts` (named in
  the rider's language; Android 7 has no channels, and the plugin's refusal to make one is ignored) with the
  white bike `ic_stat_bike`.
- **Share links open the apps** (Universal Links, App Links): the apps claim `https://badgerbikes.app/` (any query;
  `/analytics` and other paths stay in the browser): iOS through the Associated Domains entitlement
  (`ios/App/App/App.entitlements`, set for Release builds only, since Apple's free Personal Team can't sign it and
  Debug builds should still run on a free account), Android through an `autoVerify` intent filter. Each platform
  checks the site: the Worker serves `/.well-known/apple-app-site-association` once `NATIVE_APP.appleTeamId` is
  set and `/.well-known/assetlinks.json` once `NATIVE_APP.androidCertFingerprints` has the signing certificate
  (`worker/appLinks.ts`; `run_worker_first` covers `/.well-known/*`). In the app, `useNativeApp`
  (`src/native/useNativeApp.ts`) opens a link from the App plugin's `appUrlOpen` event or launch URL with
  `openLaunchParams` (the same as a link at launch on the web); `appLinks.ts` ignores other sites and pages, the
  launch URL reported again after a reload, and iPhone's double report of a cold start's link.
- **Back button** (Android; `src/ui/layout/backButton.ts`): leaves a focused text field first, then closes one
  level at a time like the panels' own Back and Close buttons (About → Settings → map; a station's card, a pin,
  the planner or the list → map); on the map it sends the app to the background (`App.minimizeApp`).
- **Sharing**: the web views can't download. iOS's has Web Share (the share sheet, files included); Android's has
  none, so links go through the phone's share sheet and the GPX file is written to the app's cache folder and
  offered there (`src/native/share.ts`). Closing the sheet without choosing an app starts nothing, as on the web.
- **BCycle button**: only Chrome can open the intent:// link that launches BCycle on Android (the app's web view
  hands it to the system, which drops it), so the Android app opens BCycle's Play Store page, which shows "Open"
  when it is installed — as the iPhone button does with the App Store.
- **Links to other sites** (`target="_blank"`, Google Maps) leave the web view: Capacitor hands them to the
  system, which opens the Google Maps app when installed.
- **Look**: Android draws edge to edge with `env(safe-area-inset-*)` set as in a browser when its System WebView
  is 140 or newer (`SystemBars.insetsHandling: 'native'`; the page pads itself, `viewport-fit=cover`); older web
  views get padded by Capacitor instead, with plain system bars. The native launch screens, the web view's
  background and the page's launch screen share its teal gradient, so launching shows no flash. Icons, launch
  images and Android's notification icon are rendered from the app's artwork by `scripts/generate-icons.mjs`.
- **Identity**: app ID `app.badgerbikes` (iOS bundle ID, Android application ID) and the name Badger Bikes; the
  store identity can't change once published. The ID is in `capacitor.config.ts`, `NATIVE_APP.appId` (for the
  Worker's link files) and both native projects, and the link domain in `.env.native` and both native projects:
  `scripts/native-projects.test.mjs` keeps them equal.
- **Verified** (2026-11-19, iOS 26 simulator and an Android 16 emulator, against a local Worker): the map, live
  counts and route planning over CORS; location through the plugin (one system prompt, then the blue dot; no
  WebKit prompt); on Android the notification and "Alarms & reminders" prompts, the timer alerts scheduled exact,
  "almost up" delivered with Google Maps in front and opening the app when tapped, both cancelled by End ride;
  the back button; the GPX share sheet; share links opening the app cold and warm, not again after a reload, and
  `/analytics` staying in the browser; then the share sheet for links, the BCycle button opening the store page,
  and a dock picked from the list brought into view.
- **Not built yet**: "end dock full" while the app is in the background (it needs native push from the Worker:
  APNs with an Apple Developer account's key, Firebase Cloud Messaging for Android), haptics on iPhone, store
  listings. Untested: Universal Links on an iPhone (they need the Team ID and a paid developer account), Android's
  edge-to-edge path (the emulator's web view was 133), and real phones.
- **Build output outside the project**: `android/gradle.properties` puts Gradle's and Kotlin's per-project caches
  and every module's build directory (`bcycle.buildDir`, applied in `android/build.gradle`) under
  `/tmp/bcycle-live-android`. `app/build.gradle` copies the finished APK/AAB back to
  `android/app/build/outputs`, where `npx cap run android` and `npx cap build android` read it. Xcode's build
  products and Swift packages go to DerivedData, outside the project.
