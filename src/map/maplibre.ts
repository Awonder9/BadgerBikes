// The map runtime, loaded on demand by MapView (dynamic import): maplibre-gl and its stylesheet are about
// two thirds of the app's code, so the launch screen and the first station counts don't wait for them.
// Keep every maplibre import (even a `?url` one) in this module: a static import of anything in maplibre-gl
// from the rest of the app would pull the whole library back into the startup bundle.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { setWorkerUrl } from 'maplibre-gl'
import './maplibre.css'

// Vite's dependency pre-bundling breaks maplibre's own worker URL resolution, so point it at the bundled
// worker before any map exists (this module is the only way the app gets a Map).
setWorkerUrl(workerUrl)

export { GPUInitializationError, Map } from 'maplibre-gl'
