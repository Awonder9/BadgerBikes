# Badger Bikes

An unofficial companion app for BCycle bike share — not affiliated with BCycle or Revolution.

Live BCycle bike and dock availability on a map, plus ride planning that hands navigation to Google Maps.
Works in every BCycle city: the first visit picks the city nearest you (from your approximate network
location — no location prompt; Madison if none is near), and Settings → City switches it.

## How a ride works

1. **Start anywhere** — *Start from my location*, search a place or dock, or tap a dock on the map. From
   a place, the app picks the best dock to walk to (nearby docks with bikes, ranked by walking time plus the
   ride toward your destination) and lists a couple of alternatives. The dock card shows its e-bike /
   classic mix. Already riding? *I'm already on a bike* asks when you unlocked it, then plans from where you
   are with the ride timer running from then.
2. **Pick where you're going** — any place or a dock, or a one-tap chip for a saved or recent place.
   Going to several places? *Add a stop* (up to 10): each leg is its own ride — dock near a stop, then pick up
   a bike there for the next leg. The planner shows one leg at a time (*Leg 2 of 3*); tap a stop to plan its
   leg, reorder or remove stops. After a leg's last Google Maps link (or arriving), the app asks whether the leg
   is done and whether you docked: *Finish leg* drops it and plans the next one — after docking with the ride
   timer stopped, or on the same bike with the timer still running. *Share*
   sends the whole trip, opening on the leg you're looking at.
3. **Choose a route** — two options side by side, each with time, distance and the waypoints it sends
   Google Maps: *Direct* (the default: Google Maps picks the streets between your docks, so the line is a
   preview and there are no waypoints) and *Bike-friendly* (as few cars as possible; Google Maps is held to
   its trails and paths with a waypoint on each). When the two are the same path, the card says so. Below them: the **whole trip** (walk → ride → walk),
   **walking straight there** for comparison, and the chosen route's **path breakdown** (bike path,
   shared-use path, bike lane, shared lane, quiet street, road with traffic) and **elevation** (▲ climb ·
   ▼ descent with a small profile). On the map, the chosen route is colored by type of road in the same
   colors as the breakdown (greens = away from cars, blue/teal = bike lanes, amber = shared lane, gray =
   quiet street, red = road with traffic).
4. **Stops** — *Optimized stops* are preselected: the fewest docks that keep every ride between docks
   under your max ride time (Settings → *Max ride between docks*: 25 min by default, up to 60, or
   Unlimited), ending at the dock closest to your destination. Other docks on the route line are listed
   as *Optional stops* you can check. Timing uses the chosen route's own pace, so it matches the route
   cards.
5. **Open in Google Maps** — bicycling directions through your chosen docks, plus a walking link to the
   destination. A Maps link can't carry the route line, so Google plans its own path between points, and
   every point is a stop you confirm in Google Maps. Docks are sent as the point on the route line (a dock
   on a side street makes Google loop around the block). *Direct* sends nothing else; *Bike-friendly* adds
   one point on each trail/path section so Google doesn't swap it for a parallel road. Google's mobile app
   takes 3 stops per link, so a ride with more is split into parts that end at a dock when possible.
   **Or use Komoot / OsmAnd** — *Exact route for Komoot / OsmAnd* saves the ride as one GPX file. Those
   apps follow the exact line turn by turn: no 3-stop limit, no parts, no detours.
6. **Ride** — after you open a part, the app tracks which parts you've opened ("Next: Part 2 → dock"),
   times the ride against your pass (it asks which pass you have on your first ride), and watches your end
   dock (with nearby docks if it fills up). Docked somewhere else on the way and took a bike again? *Docked along
   the way* restarts the timer (with undo) and keeps the rest of the plan. With alerts on, "ride time almost up" and "end dock full" reach
   you even while Google Maps is in front (on iPhone, once the app is on your Home Screen — the how-to can be
   hidden from the planner with ✕ and stays in Settings; in the iOS and Android
   apps, "ride time almost up" does and the end dock is checked while the app is open). The plan is
   saved on the device until you open the last link (the walk, or the last ride part) or arrive, so coming
   back from Google Maps finds it intact. When you start from a place, the timer waits until you tap
   *I've unlocked a bike*. *Share* sends a link to the same ride.

**Just ride** — no destination in mind? Under *Where to?*, *Just ride* plans a ride of the length you pick
(15–90 min; your pass's included time by default), **back at the start dock** or **ending at another dock** with
space. It follows bike trails and passes scenic places — lakeshores, parks, viewpoints — from OpenStreetMap, and
lists what you'll pass. *Try another ride* picks a different one. It's then an ordinary plan: docks along the way,
Google Maps (held to the ride's shape with waypoints) or the Komoot/OsmAnd file.

**Your rides** — every ride you start from a plan is saved on your device (home panel, or Settings → *Your rides &
reviews*), with **weekly, monthly and yearly reviews** played as story cards: distance and time, your go-to dock and
route, how much was on trails, your longest ride, riding habits and streaks, CO₂ saved, and your rider "persona".
The home panel offers last week's review early in a week, last month's early in a month, and the year's in December
and January. The app can't record GPS while Google Maps is in front, so a ride is the route as planned, timed from
the ride timer to when you end it in the app (or the route's riding time, marked "~", when it never saw you dock —
you can correct it).

**Send to Strava** — once connected (*Connect with Strava* in Your rides), a ride can be sent to Strava as an
activity, named and marked as a commute if you like. Its map is the route as planned, with times spread over the
ride, and its description says so: it isn't a recorded GPS track.

Also: **Nearest open dock** (where can I return this bike?) finds the closest dock with room from your
location; each station card has walking **Directions**, **Share** and **Street View** (what the dock looks like
from the street); **Prefer e-bikes** (in cities with both kinds) makes the map count e-bikes; the home panel and
the planner show the city's **weather** (temperature, wind and gusts, sunrise and sunset); a multi-stop trip
keeps its finished legs on the map in violet and keeps your route option from leg to leg; and an offline banner
says when the counts can't update. Follow the app on Instagram: [@badgerbikes.app](https://www.instagram.com/badgerbikes.app/).

If the free routing server is busy, the app says so and asks you to try again in a few seconds.
Saved places, recents, the current ride and your ride history live in the browser on that device only (a ride
leaves it only if you send it to Strava). The app sends anonymous
usage counts (no identifier or location) for the operator's dashboard; Do Not Track or Global Privacy
Control turns them off.

## Run it locally

```bash
npm install
npm run dev          # http://localhost:5173 — app + Cloudflare Worker API together
```

- `?start=<station id>&to=<lat,lon>&toName=…` opens a shared ride.
  Add `&stop=<lat,lon>,<dock id or empty>,<Name_With_Underscores>` per further stop (and `&leg=2`) for a trip.
- Phone testing needs HTTPS for GPS: `brew install cloudflared`, then
  `cloudflared tunnel --url http://localhost:5173` and open the printed `https://…trycloudflare.com` link.
- `npm run preview` builds and serves the production build in Cloudflare's runtime locally.

## Deploy to Cloudflare

```bash
npx wrangler login                      # once
npx wrangler secret put CONTACT_EMAIL   # once: your operator contact email (see below)
npm run deploy                          # builds, then wrangler deploy
```

For local development, copy `.dev.vars.example` to `.dev.vars` and put your email there (it is never
committed).

**Background ride alerts (optional):** they need a VAPID key pair of your own. `npm run vapid-keys`
prints one; set both with `npx wrangler secret put VAPID_PUBLIC_KEY` and `npx wrangler secret put
VAPID_PRIVATE_KEY` (and paste both lines into `.dev.vars` to try them locally — they need the production
build: `npm run preview`). Without the keys everything else works the same, and ride alerts show only
while the app is open. During a ride with alerts on, the Worker keeps that ride's timer, end dock and push
subscription (no location) until the ride ends, at most 4 hours.

**Send to Strava (optional):** create a Strava API app at <https://www.strava.com/settings/api> with your site's
domain as its *Authorization Callback Domain* (`localhost` works for development), then `npx wrangler secret put
STRAVA_CLIENT_ID` and `npx wrangler secret put STRAVA_CLIENT_SECRET` (and both in `.dev.vars` locally). Without them
the Strava parts of the app stay hidden. A new Strava app accepts only its owner's account ("single player mode")
until you raise its athlete capacity in Strava's API settings (10 athletes) or Strava reviews it (more than 10). The
Worker only exchanges tokens and forwards uploads; it stores nothing.

**Usage dashboard:** `https://<your domain>/analytics` (badgerbikes.app/analytics) shows unique users
(today, 7, 30 and 90 days, all time), who is using the app now, new vs returning users, routes planned and
rides started, when people use it, cities, devices, browser vs Home Screen web app vs the iOS/Android apps,
languages and feature use. Nothing to set up, and nothing in the app links to it; it's website-only (the
iOS/Android apps don't include it). The counts are anonymous: the app sends no
identifier, IP-derived data or location (how unique users are counted without one:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §8a), and browsers with Do Not Track or Global Privacy
Control send nothing.

**Why the contact email:** the free FOSSGIS routing servers and Photon search ask every app to identify
itself so their operators can reach you before blocking it. The email is sent with each request and
shown on the About page. For heavy traffic, point `VITE_VALHALLA_URL` / `VITE_OSRM_*` at a self-hosted or
commercial Valhalla-compatible service.

## iOS and Android apps

The app also runs as a native iOS and Android app ([Capacitor](https://capacitorjs.com)): `ios/` and `android/`
are the native projects and `capacitor.config.ts` their settings. The apps load the app from the phone and talk to
the deployed site (`VITE_WEB_ORIGIN` in `.env.native`: https://badgerbikes.app), so deploy the Worker first. It
answers the apps' cross-origin requests.

```bash
npm run ios            # build the app for the phones, copy it into ios/, open Xcode, then press Run
npm run android        # the same, opening Android Studio
npm run build:native   # only build and copy (after changing src/, before running from Xcode / Android Studio)
```

- iOS needs Xcode; Android needs Android Studio (Gradle uses the JDK 21 it ships with). To run on your own
  iPhone, pick your Apple developer team once in Xcode → App target → Signing & Capabilities.
- Gradle keeps its build files in `/tmp/bcycle-live-android` (`android/gradle.properties`); the finished APK is
  copied back to `android/app/build/outputs`.
- Live reload in the iOS Simulator: `npm run dev`, then `npx cap run ios --live-reload --host localhost --port 5173`.
- To try a native build against your local Worker, put `VITE_WEB_ORIGIN=http://localhost:5173` in
  `.env.native.local` (gitignored) while `npm run dev` runs. The Android emulator also needs
  `adb reverse tcp:5173 tcp:5173` and, while testing only, `server: { cleartext: true }` in `capacitor.config.ts`
  (Android refuses plain `http://`).
- **Share links opening the apps** (instead of the browser): set `appleTeamId` (developer.apple.com → Account →
  Membership details) and `androidCertFingerprints` (Play Console → Test and release → App integrity → App
  signing: the SHA-256 fingerprint) in `NATIVE_APP` in `src/config.ts`, then `npm run deploy`; the Worker then
  serves the files Apple and Google check. On iPhone this needs a paid Apple Developer Program membership: the
  Associated Domains entitlement is on for Release builds only, so Debug builds still run with a free account.
- **Ride alerts in the apps**: "ride time almost up" and "past your included time" are scheduled on the phone and
  arrive while Google Maps is open; Android also asks to allow "Alarms & reminders" so they come on time. "End dock
  full" shows while the app is open (in the background it would need native push).
- `node scripts/generate-icons.mjs` renders the app icons, launch screens and Android's notification icon from
  the app's artwork.
- Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §12.

## Forking

You're welcome to run your own copy (MIT license). Before deploying it, please make it yours:

- set **your own** `CONTACT_EMAIL` secret (above);
- change `APP.repoUrl` and `APP.userAgent` in `src/config.ts` to your repository, so the public servers
  can tell your deployment apart from this one;
- change `APP.name` (and the PWA name in `vite.config.ts`) and the custom domain in `wrangler.jsonc`;
- for the iOS/Android apps: your own app ID (`appId` in `capacitor.config.ts` and `NATIVE_APP.appId` in
  `src/config.ts`; an app ID can't be reused in the App Store or Google Play) and name (`appName`), and your domain
  in `.env.native`, `ios/App/App/App.entitlements` and `android/app/src/main/AndroidManifest.xml`
  (`npm run check` tells you if they disagree).

## Checks

```bash
npm run check        # typecheck + lint + unit tests
npm run e2e          # Playwright smoke tests (phone + desktop, network-free)
```

**"Just ride" scenery:** each city's trails and scenic places are generated from OpenStreetMap (Overpass API) into
`src/data/scenic/<city>.json` by `npm run update-scenic` (or `npm run update-scenic -- <city id>`), one query per
city, spaced out; the app never queries Overpass itself. The public Overpass server is often busy: the script backs
off and retries, `OVERPASS_URL=…` points it at another instance, and `OVERPASS_TIMEOUT_S=120` gives a big city
more time. A city without a file still gets rides, along the quietest streets and paths, just without scenic stops.

## How it works

- **Cloudflare Worker** (`worker/`): fetches and caches BCycle GBFS feeds, computes the route
  options (Valhalla, OSRM fallback), geocodes (Photon), fetches the city's weather (Open-Meteo), and enforces the public servers' 1 request/second
  policy globally with a Durable Object. Another Durable Object per device sends background ride alerts
  (Web Push, encrypted with WebCrypto; no push library).
- **Browser** (`src/`): MapLibre map and UI; `src/ride/` finds docks along the route, builds the Google
  Maps links (no API key needed) and keeps the ride plan and progress. `src/analytics/` is the separate
  `/analytics` page.
- **iOS and Android apps** (`ios/`, `android/`): Capacitor shells around the same app, calling the deployed
  Worker, with a few plugins (`src/native/`) for location, notifications, share links and the back button.
- Design and rationale: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## License and data

Code: [MIT](LICENSE). Not affiliated with BCycle or Revolution; "BCycle" is their trademark and is used
only to describe what the app works with.

Data shown in the app and in the test samples (`src/test/fixtures/`):
- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL), via
  OpenFreeMap tiles, Valhalla and OSRM routing (FOSSGIS e.V.), Photon search (komoot), and the Overpass API
  (the trails and scenic places in `src/data/scenic/`).
- Station data from BCycle's public GBFS feeds.
- Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0).
