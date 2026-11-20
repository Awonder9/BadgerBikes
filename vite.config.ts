import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import capacitorConfig from './capacitor.config.ts'

// https://vite.dev/config/
// The Cloudflare plugin runs worker/index.ts inside workerd during `vite dev` / `vite preview`, so
// /api/* is served locally by the same code that is deployed.
//
// `--mode native` (npm run build:native) builds the web app for the iOS/Android apps (capacitor.config.ts) instead:
// into Capacitor's webDir, without the Worker (the apps call the deployed site, VITE_WEB_ORIGIN in .env.native),
// the service worker (the apps ship their files) or the usage dashboard.
export default defineConfig(({ mode }) => {
  const native = mode === 'native'
  if (native) checkWebOrigin(loadEnv(mode, process.cwd(), 'VITE_').VITE_WEB_ORIGIN)
  // The app, and the usage dashboard (/analytics) as a page of its own: the app never loads or links to it.
  const pages: Record<string, string> = native ? { main: 'index.html' } : { main: 'index.html', analytics: 'analytics.html' }
  return {
    // Keep Vite's dependency cache out of the project folder: cloud-synced folders (OneDrive, iCloud,
    // Dropbox) corrupt it while Vite rewrites it, which breaks the dev server with 504s.
    cacheDir: process.env.VITE_CACHE_DIR ?? join(tmpdir(), 'bcycle-live-vite-cache'),
    // Same reason for build output (OneDrive renames folders it is syncing mid-build, e.g. "assets 2").
    // `wrangler deploy` finds the output through .wrangler/deploy/config.json. Set BUILD_OUT_DIR=dist in CI.
    // A native build never writes there (no Cloudflare plugin), so it can't be deployed by mistake.
    build: {
      outDir: native ? capacitorConfig.webDir : (process.env.BUILD_OUT_DIR ?? join(tmpdir(), 'bcycle-live-dist')),
      emptyOutDir: true,
      // Libraries that rarely change get their own long-cached files, so after a deploy phones re-download
      // only the app code (maplibre alone is most of the bundle). Everything matching the maplibre group lands
      // in the lazily loaded map chunk: import maplibre-gl only from src/map/maplibre.ts. (Preloading that chunk
      // from index.html, even at low priority, was measured to delay the first station counts on a slow phone.)
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: 'maplibre', test: /node_modules[\\/]maplibre-gl/ },
              { name: 'vendor', test: /node_modules[\\/](react|react-dom|scheduler|@tanstack|zustand)[\\/]/ },
            ],
          },
          // The Capacitor plugins' chunks (src/native/plugins.ts and the plugins' lazy parts) are loaded only inside
          // the iOS/Android apps: named native-* so the web app's service worker can leave them out. (A chunk group
          // would also take Vite's preload helper along, which the startup code shares.)
          chunkFileNames: (chunk) => (NATIVE_CHUNK.test(chunk.facadeModuleId ?? '') ? 'assets/native-[name]-[hash].js' : 'assets/[name]-[hash].js'),
        },
      },
    },
    environments: {
      // Client build only: a top-level input would also become the Worker build's entry.
      client: { build: { rolldownOptions: { input: pages } } },
    },
    plugins: [
      react(),
      tailwindcss(),
      ...(native ? [] : [cloudflare()]),
      VitePWA({
        // Native apps: no service worker or web manifest; virtual:pwa-register/react becomes a no-op, so the
        // "Update available" prompt never shows there (an app update comes from the App Store / Google Play).
        disable: native,
        // 'prompt' (never autoUpdate): an update must never reload the page mid-navigation. The app shows
        // "Update available" only while not navigating (useRegisterSW from virtual:pwa-register/react).
        registerType: 'prompt',
        injectRegister: false,
        includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'Badger Bikes — live BCycle bikes, docks & ride planning',
          short_name: 'Badger Bikes',
          description: 'Live BCycle bike and dock availability with ride planning and Google Maps directions.',
          theme_color: '#0f766e',
          background_color: '#ffffff',
          display: 'standalone',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // App shell only. Live data (/api/*) and map tiles are never cached by the service worker.
          globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
          // The usage dashboard is for the operator: never downloaded to riders' phones. Nor are the native apps'
          // plugins, which a browser never loads.
          globIgnores: ['analytics.html', 'assets/analytics-*', 'assets/native-*'],
          navigateFallback: 'index.html',
          navigateFallbackDenylist: [/^\/api\//, /^\/analytics/],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
          runtimeCaching: [],
          // Tapping a ride alert (shown through the service worker) focuses the app.
          importScripts: ['sw-notifications.js'],
        },
      }),
    ],
    server: {
      port: 5173,
      // The Worker answers CORS for /api/* itself (the native apps; worker/app.ts). Vite's own CORS handling (also
      // used by `vite preview`) would answer their preflights first, without their origins, as production never does.
      cors: false,
      // Phones only allow GPS on HTTPS pages. `cloudflared tunnel --url http://localhost:5173`
      // (brew install cloudflared) gives the dev server a temporary https://*.trycloudflare.com URL.
      allowedHosts: ['.trycloudflare.com'],
    },
  }
})

const NATIVE_CHUNK = /node_modules[\\/]@capacitor[\\/]|src[\\/]native[\\/]plugins\.ts$/

/** The native apps load the app from the phone and call the deployed site, so a native build needs its address. */
function checkWebOrigin(origin: string | undefined): void {
  let url: URL | null = null
  try {
    url = new URL(origin ?? '')
  } catch {
    /* reported below */
  }
  // https, or http on this computer (a simulator against `npm run dev`); an origin, not a page.
  const ok = !!url && (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')) && url.pathname === '/' && !url.search
  if (!ok) {
    throw new Error(
      `A native build needs VITE_WEB_ORIGIN, the deployed web app (e.g. https://badgerbikes.app), in .env.native ` +
        `or .env.native.local; got ${JSON.stringify(origin ?? null)}.`,
    )
  }
}
