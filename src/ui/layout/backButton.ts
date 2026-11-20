// The Android app's back button (src/native/useNativeApp.ts): closes what is open, one level at a time, the way
// the panels' own Back and Close buttons do.
import type { AppActions, AppState } from '../../store/types'

/** One step back; false when there is nothing left to close (the app then goes to the background). */
export function goBack(app: AppState & AppActions): boolean {
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
    case 'list':
    case 'settings':
      app.setPanel('browse')
      return true
    case 'browse':
      return false
  }
}
