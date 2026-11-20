// The Capacitor plugins: the only module that imports them. It is loaded on demand through nativePlugins()
// (./index.ts) and only inside the iOS/Android apps, so the web app never downloads it.
export { App } from '@capacitor/app'
export { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
export { Geolocation } from '@capacitor/geolocation'
export { LocalNotifications } from '@capacitor/local-notifications'
export { Share } from '@capacitor/share'
