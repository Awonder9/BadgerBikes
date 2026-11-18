# Badger Bikes (BCycle live map + ride planning)

Mobile-first React web app: live BCycle bike-share station availability on a map, plus ride planning
(start dock → destination → route option → docks along the route) handed off to Google Maps for
turn-by-turn directions, with ride progress tracked in the app.
`docs/ARCHITECTURE.md` is the design contract — read the relevant sections before changing code.

## Commands
- `npm run dev` — app + Cloudflare Worker API on http://localhost:5173 (Worker runs in workerd via
  `@cloudflare/vite-plugin`; share links like `?start=<station id>&to=<lat,lon>` are handy)
- `npm run check` — typecheck (`tsc -b`) + lint (`oxlint`) + unit tests (`vitest run`)
- `npx vitest run src/<dir>` — run a subset of unit tests
- `npm run build` — production build to `$TMPDIR/bcycle-live-dist` (outside OneDrive; `BUILD_OUT_DIR=dist` overrides)
- `npm run preview` — build, then serve the production build in workerd locally
- `npm run deploy` — build + `wrangler deploy` to Cloudflare (needs `npx wrangler login` once)
- `npm run cf-typegen` — regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc`
- `npm run e2e` — Playwright smoke tests (Chromium, network-free) in `e2e/`
- Dev-only debugging: `window.__bcycle.app` / `window.__bcycle.ride` expose the Zustand stores
- `npm run update-systems` — regenerate `src/data/systems.json` from the live BCycle feeds

## Where code runs
- `worker/` — Cloudflare Worker: `/api/*` (stations, route options, geocoding). All upstream API
  calls happen here, never from the browser.
- `src/` — the React client; docks-along-route, Google Maps links and ride progress run on the device.
- Pure modules in `src/` that the Worker imports must be runtime-agnostic: no DOM, no Node APIs.
  `tsconfig.worker.json` (no DOM lib) enforces this for everything the Worker imports.

## Versions — newer than most training data
vite 8, react 19.3, maplibre-gl 6.19 (ESM-only), @tanstack/react-query 5, zustand 5, Tailwind 4
(`@tailwindcss/vite`, CSS-first config, no `tailwind.config.js`), vitest 5, TypeScript 7 (native `tsc`),
oxlint (not ESLint). Before using a library API you are not certain about, check its type definitions in
`node_modules/<pkg>/` rather than relying on memory.

## Rules
- Shared contracts live in `src/types.ts`, `src/config.ts`, and the interface files named in
  docs/ARCHITECTURE.md. Do not change a contract you do not own; if you need a change, say so in your
  final report instead.
- All network access goes through `src/lib/http.ts` (`fetchJson`: timeout, AbortSignal, typed errors,
  per-host rate limiting) — in the Worker via `worker/upstream.ts`, in the client via `src/api/client.ts`.
  Never call `fetch()` directly anywhere else.
- Never put feed/API strings into HTML: no `innerHTML`, no `dangerouslySetInnerHTML`, no maplibre
  `Popup.setHTML`. Station names contain `&` and other characters. Render text through React.
- Tunables (poll intervals, thresholds, speeds, URLs, limits) belong in `src/config.ts`, not inline.
- Pure logic (`src/lib`, `src/routing`, `src/ride` except `rideStore.ts`, formatting)
  must not import React, maplibre-gl, or touch browser globals; inject clocks, routers, and IO so tests
  are deterministic.
- Tests are colocated as `*.test.ts(x)` next to the module. Use the real captured API responses in
  `src/test/fixtures/` (see its README) instead of hand-written mock payloads.
- maplibre-gl: call `setWorkerUrl()` with the URL from
  `import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'` before creating a map —
  Vite's dependency pre-bundling breaks maplibre's default worker URL resolution.
- `tsconfig` has `noUncheckedIndexedAccess`: array/record indexing returns `T | undefined`; handle it.
- Import paths omit file extensions (`import { x } from '../lib/geo'`), except in the root config files.
- Coordinates are `[lon, lat]` (`LngLat`) everywhere in app code, matching GeoJSON/maplibre. Distances
  are meters and durations are seconds internally; convert only for display (`src/lib/format.ts`).
