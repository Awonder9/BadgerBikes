// Capacitor: the iOS and Android apps (ios/, android/) are this web app in a native shell. `npm run build:native`
// builds it in Vite mode "native" (vite.config.ts) into webDir and copies it into both projects; the apps then
// talk to the deployed site (VITE_WEB_ORIGIN in .env.native). See docs/ARCHITECTURE.md §12.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  // The apps' identity in the App Store and Google Play (reverse domain of badgerbikes.app): it can't change once
  // published. Forks: use your own.
  appId: 'app.badgerbikes',
  appName: 'Badger Bikes',
  // Outside the cloud-synced project folder, like the web build (vite.config.ts builds here in native mode).
  webDir: join(tmpdir(), 'bcycle-live-native'),
  // Behind the page until it paints: the launch screen's teal (index.html .splash), so the native launch screen,
  // the web view and the page's own launch screen show one color.
  backgroundColor: '#0f766e',
  // server.* is left at Capacitor's defaults (capacitor://localhost on iOS, https://localhost on Android): the
  // Worker allows exactly those origins (NATIVE_APP.origins in src/config.ts), and the saved plan and places
  // live in that origin's storage.
  plugins: {
    // Android: edge to edge, with env(safe-area-inset-*) set as in a browser (index.html has viewport-fit=cover
    // and the app pads itself with them).
    SystemBars: { insetsHandling: 'native', initialViewportFitValueHint: 'cover' },
  },
}

export default config
