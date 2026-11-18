import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
// The Cloudflare plugin runs worker/index.ts inside workerd during `vite dev` / `vite preview`, so
// /api/* is served locally by the same code that is deployed.
export default defineConfig({
  // Keep Vite's dependency cache out of the project folder: cloud-synced folders (OneDrive, iCloud,
  // Dropbox) corrupt it while Vite rewrites it, which breaks the dev server with 504s.
  cacheDir: process.env.VITE_CACHE_DIR ?? join(tmpdir(), 'bcycle-live-vite-cache'),
  // Same reason for build output (OneDrive renames folders it is syncing mid-build, e.g. "assets 2").
  // `wrangler deploy` finds the output through .wrangler/deploy/config.json. Set BUILD_OUT_DIR=dist in CI.
  build: { outDir: process.env.BUILD_OUT_DIR ?? join(tmpdir(), 'bcycle-live-dist'), emptyOutDir: true },
  plugins: [
    react(),
    tailwindcss(),
    cloudflare(),
    VitePWA({
      // 'prompt' (never autoUpdate): an update must never reload the page mid-navigation. The app shows
      // "Update available" only while not navigating (useRegisterSW from virtual:pwa-register/react).
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Badger Bikes — live BCycle bikes, docks & ride planning',
        short_name: 'Badger Bikes',
        description: 'Live BCycle bike and dock availability with bike-share-aware turn-by-turn navigation.',
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
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    port: 5173,
    // Phones only allow GPS on HTTPS pages. `cloudflared tunnel --url http://localhost:5173`
    // (brew install cloudflared) gives the dev server a temporary https://*.trycloudflare.com URL.
    allowedHosts: ['.trycloudflare.com'],
  },
})
