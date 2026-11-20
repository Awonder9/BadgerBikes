// Share links opening the iOS/Android apps (Universal Links, App Links): which links the apps open, and each only
// once. A link arrives as an event while an app runs; one that launched it is also kept as its launch URL, which
// is reported again after every reload of the page (on iPhone: the last link, for as long as the app runs), and
// on iPhone a cold start reports it both ways. Pure: no plugins, no storage of its own.
import { NATIVE_APP } from '../config'

/** The link's query ("?system=…&station=…") when it is a link to the web app's start page; otherwise null. */
export function appLinkSearch(url: string, webOrigin: string): string | null {
  let link: URL
  let origin: URL
  try {
    link = new URL(url)
    origin = new URL(webOrigin)
  } catch {
    return null
  }
  if (link.protocol !== 'https:' || link.host !== origin.host || (link.pathname !== '/' && link.pathname !== '')) return null
  return link.search
}

/** The link this page opened last (kept in session storage, which survives reloads of the page). */
export interface OpenedLink {
  url: string
  atMs: number
}

export function shouldOpenLink(url: string, via: 'launch' | 'event', last: OpenedLink | null, nowMs: number): boolean {
  if (!last || last.url !== url) return true
  // The launch URL again: this page was reloaded, and it already opened that link.
  if (via === 'launch') return false
  // The same link as an event: the cold start's second report, or the rider opening the link again later.
  return nowMs - last.atMs > NATIVE_APP.repeatedLinkMs
}
