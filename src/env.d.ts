interface ImportMetaEnv {
  /** Override the Valhalla routing base URL (default: FOSSGIS public instance). */
  readonly VITE_VALHALLA_URL?: string
  /** Override the OSRM bicycle profile base URL (default: FOSSGIS routed-bike). */
  readonly VITE_OSRM_BIKE_URL?: string
  /** Override the OSRM foot profile base URL (default: FOSSGIS routed-foot). */
  readonly VITE_OSRM_FOOT_URL?: string
  /** Override the Photon geocoder base URL (default: photon.komoot.io). */
  readonly VITE_PHOTON_URL?: string
  /** Override the Overpass API URL for loop scenery (default: https://overpass-api.de/api/interpreter). */
  readonly VITE_OVERPASS_URL?: string
  /** Override the GBFS base URL (default: https://gbfs.bcycle.com). */
  readonly VITE_GBFS_BASE?: string
  /** The deployed web app the native apps talk to (`.env.native`; unset in the web app). See NATIVE_APP.webOrigin. */
  readonly VITE_WEB_ORIGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
