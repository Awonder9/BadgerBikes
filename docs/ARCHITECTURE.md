# Badger Bikes — Architecture (v2)

Status: **v2** (2026-11-18). v1 had an in-app turn-by-turn navigation engine and a walk–bike–walk trip
planner; both were removed when navigation moved to Google Maps. Code contracts live in `src/types.ts`,
`src/config.ts` (every tunable), `src/api/contract.ts`, `src/routing/types.ts`, `src/store/types.ts`,
`src/map/types.ts` and `src/lib/upstream.ts`. When this document and a contract file disagree, the contract
file wins; fix the doc.

---

## 1. Product scope

A mobile-first web app (installable PWA) for BCycle riders in any BCycle city. The first visit picks the
city nearest the rider (`GET /api/locate`, from Cloudflare's city-level request location — no permission
prompt; `APP.defaultSystemId` = Madison when none is within `SYSTEM_DETECT.maxDistanceMeters`); Settings →
City switches it (the current ride plan is cleared, since it belongs to the old city's stations).

1. **Live station map**: bikes and open docks, auto-refreshed, freshness badge, Bikes/Docks toggle,
   accessible station list (also the fallback without WebGL2). A launch screen covers the app until the
   first live snapshot arrives (Retry / Continue if BCycle is unreachable).
2. **Station card**: status banner, live counts with trend, ~walk estimate, *Start ride here* / *Ride to
   here*, a *BCycle* button (app hand-off), *Watch this station*, star.
3. **Ride planner** (§7): start dock (search, map tap, or *Nearest dock with bikes*) with its e-bike/classic
   mix → destination (search, map tap, quick chips for saved and recent places) → three route options
   (*Bike-friendly*, *Balanced*, *Fastest*) → docks along the route (preselected, uncheck to skip) →
   Google Maps links (split into parts) + a walking link.
4. **Ride in progress**: parts opened are tracked ("Next: Part 2 → dock"), ride timer against the pass's
   included minutes, end-dock watch with nearby replacement docks, alerts while the app is open, a banner
   back to the plan. The plan and progress persist on the device until the last link (walk, or last ride
   part) is opened or the rider arrives, because switching to Google Maps can reload the page.
5. **Share a ride**: link with start dock, destination and route option (Web Share or clipboard).
6. **Search**: local station match + Photon places; saved places (Home/Work/starred) and recents.
7. **First-visit tip**: how to add the app to the home screen (iOS Safari / Android Chrome), shown once.
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

**Endpoints** (`src/api/contract.ts`): `GET /api/health`, `GET /api/meta`, `GET /api/stations?system=`,
`GET /api/system?system=`, `GET /api/locate` (nearest city), `POST /api/routes` (three bike route options), `POST /api/route-details`
(path breakdown + elevation), `GET /api/geocode?q=&system=[&lat=&lon=]`,
`GET /api/reverse?lat=&lon=`. Errors: `{ error: { code, message, retryable } }` with 4xx/5xx; codes from
`AppErrorCode`.

- Validate everything: `system` must match a registry id; coordinates finite and in range; strings trimmed
  and length-limited; body ≤ `HTTP.maxBodyBytes`. Unknown fields ignored.
- Per-client-IP limits via Rate Limiting bindings (`ROUTE_LIMITER`, `GEOCODE_LIMITER`); exceeded → 429
  `rate_limited`.
- Responses: JSON, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, same-origin only.

**Upstream layer (`worker/upstream.ts`)**: cache (per-isolate LRU, then the Cache API) → `UpstreamGate`
Durable Object per group (`interactive > background` priority, ≥ `minSpacingMs` between request starts,
≤ `maxInFlight`, queue deadlines, circuit breaker on 429/503 or repeated errors; a denial is
`upstream_unavailable`) → fetch with `APP.userAgent` + contact email → cache with TTL. The gate's logic is
a pure core (`worker/gateCore.ts`) tested in Node; `worker/gate.ts` is the thin Durable Object.

**Capacity**: FOSSGIS allows ~1 request/second for the whole site, and one `/api/routes` call makes three
Valhalla requests. When the gate or the servers refuse, the route options would degrade to straight-line
guesses, which are useless for finding docks — so `/api/routes` returns 503 `upstream_unavailable` instead
and the planner shows "Route server busy … try again in a few seconds" with a short countdown
(`RIDE.busyRetrySeconds` = 3). Already-computed options are cached, so the retry is cheap.

**Static asset headers** (`public/_headers`): CSP (`connect-src 'self' https://tiles.openfreemap.org`, …),
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`,
`Permissions-Policy: geolocation=(self), camera=(), microphone=()`.

---

## 5. Data (`src/data`, `src/geocode`, `scripts/update-systems.mjs`)

- `normalizeStationInformation`: trim names; `coord = [lon, lat]`; drop invalid/0,0 coords; `hasKiosk =
  _bcycle_station_type === 'Kiosk and Station'`; keep only `https://` rental URIs on `bcycle.com` or a subdomain.
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
`ManeuverKind` (street names are used to find trail sections, §7).

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
route's pace (duration ÷ distance) so they match the route cards. The last checked dock ends the ride.

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
location permission was already granted; the app never prompts for this). Changing the plan clears
progress and saves again. Opening a part that
starts at a dock (the rider unlocks a bike there) restarts the ride timer.

**Ride in progress** (`rideProgress.ts` pure; `useRideStatus.ts`, `RideProgress.tsx`): timer vs the pass's
included minutes (warn at `RIDE.timerWarnMinutes`), end dock `ok | low | full` for the party, replacement
docks with space within `RIDE.replacementRadiusMeters` of the destination (each with a Google Maps link from
the rider's position), one-shot alerts (vibration + system notification if permitted). A web page cannot run
while Google Maps is in front, so alerts and counts update when the app is open again — the UI says so.

**Share links** (`src/lib/urlParams.ts`): `?system=<id>&start=<station id>&to=<lat,lon>&toName=&toStation=&route=<0-2>`,
validated on load, applied to the ride store, then removed from the address bar.

---

## 8. Client UI (`src/ui`, `src/map`, `src/store`, `src/location`, `src/data/hooks.ts`)

- **Layout**: MapView mounted once. Desktop side panel for wide screens; otherwise full-screen map + bottom
  sheet (peek/half/full in `svh`, so the on-screen keyboard never resizes it; "full" stops below the map
  buttons). `h-dvh`, safe-area insets.
- **Map**: only `src/map/MapView.tsx` imports maplibre (`setWorkerUrl` first). Station source with
  `promoteId: 'id'`; mode toggle changes paint only; chosen route on top of faded alternatives; start/stops/
  end rings; user location dot from `useLocationStore` (outside React). While planning, a tapped dock fills
  the planner (start, then destination) instead of opening the station card.
- **Location** (`src/location/locationStore.ts`): watched only after the rider asks (Locate, Nearest dock,
  "My location" search); `waitForFix()` for one-shot needs.
- **Stores**: `useAppStore` (persisted: settings, saved/starred/recent places — device-only, explained in
  Settings), `useRideStore` (§7), `useLocationStore` (never persisted).
- **Refresh**: the home panel's *Refresh* button refetches station counts immediately (BCycle itself
  publishes about once a minute, so that is the freshest possible).
- **Data hooks**: `useStationsSnapshot` polls `/api/stations` (`cache: 'no-store'`) after the feed's CDN
  expiry, refetches on focus, keeps the last data on error, tracks `revision`/`changedIds`; freshness badge.
- **Map while planning**: once a route is shown, only the start dock and the docks along the route (the
  selectable stops) stay on the map; other docks are filtered out until you leave the planner.
- **Launch screen** (`LoadingScreen.tsx`) until the first snapshot; the install tip waits for it.

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

---

## 10. Testing

- Vitest `unit` (Node) for `src/**/*.test.ts` and `worker/**/*.test.ts`; `dom` (jsdom) for `*.test.tsx`.
  Real captured responses in `src/test/fixtures/` (see its README); builders in `src/test/factories.ts`.
- Key suites: GBFS normalize/merge, pricing parse, Photon, Valhalla/OSRM normalizers (RouteLeg invariants),
  router fallbacks and the busy rejection, route options, docks along the route, Google link building
  (snapping, via points, part splitting, labels), ride store persistence/progress, ride timer and end-dock
  watch, URL params, gate core, worker endpoints.
- E2E (Playwright, phone + desktop, network-free with inline `/api/*` mocks): launch screen (slow and
  failing feed), install tip, default city + City setting, shared ride link with a busy route server, plan saved
  across a reload until the last link is opened.

---

## 11. Deployment & operations

Cloudflare Workers + static assets (`wrangler.jsonc`, custom domain badgerbikes.app). `npm run deploy`
builds and runs `wrangler deploy`; `npm run cf-typegen` after changing bindings. Free plan limits are ample
(I/O-bound requests). For heavier traffic than FOSSGIS allows, point `VITE_VALHALLA_URL` / `VITE_OSRM_*` at a
self-hosted or commercial Valhalla-compatible service. PWA: `registerType: 'prompt'`, no runtime caching of live data. When a new version is deployed, a
"Refresh" prompt stays on screen until the rider taps it (no "Later"), so nobody keeps running an old
version against a changed API.
