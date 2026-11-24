// The Android app's back button (src/native/useNativeApp.ts): closes what is open, one level at a time, the way
// the panels' own Back and Close buttons do.
import type { AppActions, AppState } from '../../store/types'

/** Full-screen overlays over the panels (a ride review's story cards), newest last: Back closes them first. */
const overlays: Array<() => void> = []

/** An overlay is open until the returned function is called; `close` is what Back does to it meanwhile. */
export function openOverlay(close: () => void): () => void {
  overlays.push(close)
  return () => {
    const i = overlays.lastIndexOf(close)
    if (i >= 0) overlays.splice(i, 1)
  }
}

/** One step back; false when there is nothing left to close (the app then goes to the background). */
export function goBack(app: AppState & AppActions): boolean {
  const overlay = overlays.at(-1)
  if (overlay) {
    overlay()
    return true
  }
  switch (app.panel) {
    case 'about':
      app.setPanel('settings')
      return true
    case 'station':
      app.selectStation(null)
      app.setPanel('browse')
      return true
    case 'pin':
      app.dropPin(null)
      app.setPanel('browse')
      return true
    case 'ride':
    case 'rides':
    case 'list':
    case 'settings':
      app.setPanel('browse')
      return true
    case 'browse':
      return false
  }
}
