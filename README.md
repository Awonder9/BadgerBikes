# Badger Bikes

An unofficial companion app for BCycle bike share — not affiliated with BCycle or Revolution.

Live BCycle bike and dock availability on a map, plus ride planning that hands navigation to Google Maps.
Works in every BCycle city: the first visit picks the city nearest you (from your approximate network
location — no location prompt; Madison if none is near), and Settings → City switches it.

## How a ride works

1. **Start anywhere** — *Start from my location*, search a place or dock, or tap a dock on the map. From
   a place, the app picks the best dock to walk to (nearby docks with bikes, ranked by walking time plus the
   ride toward your destination) and lists a couple of alternatives. The dock card shows its e-bike /
   classic mix.
2. **Pick where you're going** — any place or a dock, or a one-tap chip for a saved or recent place.
3. **Choose a route** — three options side by side: *Bike-friendly* (as few cars as possible),
   *Balanced*, and *Fastest* (the quickest of the three), each with time and distance. When two
   options are the same path, the card says so. Below them: the **whole trip** (walk → ride → walk),
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
   destination. A Maps link can't carry the route line, so Google plans its own path between points. To
   keep it on the chosen route: docks are sent as the point on the route line (a dock on a side street
   makes Google loop around the block), and route points are added so no stretch between points is longer
   than 700 m, on trail/path sections where possible. Google's mobile app takes 3 stops per link, so the
   ride is split into parts that end at a dock when possible.
   **Or use Komoot / OsmAnd** — *Exact route for Komoot / OsmAnd* saves the ride as one GPX file. Those
   apps follow the exact line turn by turn: no 3-stop limit, no parts, no detours.
6. **Ride** — after you open a part, the app tracks which parts you've opened ("Next: Part 2 → dock"),
   times the ride against your pass (it asks which pass you have on your first ride), and watches your end
   dock (with nearby docks if it fills up). With alerts on, "ride time almost up" and "end dock full" reach
   you even while Google Maps is in front (on iPhone, once the app is on your Home Screen). The plan is
   saved on the device until you open the last link (the walk, or the last ride part) or arrive, so coming
   back from Google Maps finds it intact. When you start from a place, the timer waits until you tap
   *I've unlocked a bike*. *Share* sends a link to the same ride.

Also: **Nearest open dock** (where can I return this bike?) finds the closest dock with room from your
location; each station card has walking **Directions** and **Share**; **Prefer e-bikes** (in cities with
both kinds) makes the map count e-bikes; and an offline banner says when the counts can't update.

If the free routing server is busy, the app says so and asks you to try again in a few seconds.
Saved places, recents and the current ride live in the browser on that device only.

## Run it locally

```bash
npm install
npm run dev          # http://localhost:5173 — app + Cloudflare Worker API together
```

- `?start=<station id>&to=<lat,lon>&toName=…` opens a shared ride.
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

**Why the contact email:** the free FOSSGIS routing servers and Photon search ask every app to identify
itself so their operators can reach you before blocking it. The email is sent with each request and
shown on the About page. For heavy traffic, point `VITE_VALHALLA_URL` / `VITE_OSRM_*` at a self-hosted or
commercial Valhalla-compatible service.

## Forking

You're welcome to run your own copy (MIT license). Before deploying it, please make it yours:

- set **your own** `CONTACT_EMAIL` secret (above);
- change `APP.repoUrl` and `APP.userAgent` in `src/config.ts` to your repository, so the public servers
  can tell your deployment apart from this one;
- change `APP.name` (and the PWA name in `vite.config.ts`) and the custom domain in `wrangler.jsonc`.

## Checks

```bash
npm run check        # typecheck + lint + unit tests
npm run e2e          # Playwright smoke tests (phone + desktop, network-free)
```

## How it works

- **Cloudflare Worker** (`worker/`): fetches and caches BCycle GBFS feeds, computes the three route
  options (Valhalla, OSRM fallback), geocodes (Photon), and enforces the public servers' 1 request/second
  policy globally with a Durable Object. Another Durable Object per device sends background ride alerts
  (Web Push, encrypted with WebCrypto; no push library).
- **Browser** (`src/`): MapLibre map and UI; `src/ride/` finds docks along the route, builds the Google
  Maps links (no API key needed) and keeps the ride plan and progress.
- Design and rationale: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Note on cloud-synced folders

Vite's cache and build output live in your OS temp folder, not the project, because OneDrive/iCloud
corrupt them while syncing (`BUILD_OUT_DIR=dist` overrides, e.g. for CI). Keeping the repo outside a
synced folder avoids syncing `node_modules` too.

## License and data

Code: [MIT](LICENSE). Not affiliated with BCycle or Revolution; "BCycle" is their trademark and is used
only to describe what the app works with.

Data shown in the app and in the test samples (`src/test/fixtures/`):
- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL), via
  OpenFreeMap tiles, Valhalla and OSRM routing (FOSSGIS e.V.) and Photon search (komoot).
- Station data from BCycle's public GBFS feeds.
