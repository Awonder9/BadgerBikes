// The files that let iPhones and Android phones open this site's share links in the apps instead of the browser
// (Universal Links, App Links; docs/ARCHITECTURE.md §12). Public by design, and served only once the identifiers
// they vouch for are configured (NATIVE_APP in src/config.ts).

export const WELL_KNOWN = {
  apple: '/.well-known/apple-app-site-association',
  android: '/.well-known/assetlinks.json',
} as const

export interface AppLinkIds {
  appId: string
  appleTeamId: string
  androidCertFingerprints: readonly string[]
}

/** The start page with any query: share links are `/?system=…` (a station or a ride); nothing else opens the apps. */
export function appleAppSiteAssociation(ids: AppLinkIds) {
  return { applinks: { details: [{ appIDs: [`${ids.appleTeamId}.${ids.appId}`], components: [{ '/': '/', comment: 'Share links: a station or a ride' }] }] } }
}

export function androidAssetLinks(ids: AppLinkIds) {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: ids.appId, sha256_cert_fingerprints: [...ids.androidCertFingerprints] },
    },
  ]
}

/** The file for this path, or null (not one of them, or not configured). Apple's CDN wants plain application/json. */
export function appLinksResponse(path: string, ids: AppLinkIds | undefined): Response | null {
  const body = !ids ? null : path === WELL_KNOWN.apple && ids.appleTeamId ? appleAppSiteAssociation(ids) : path === WELL_KNOWN.android && ids.androidCertFingerprints.length > 0 ? androidAssetLinks(ids) : null
  if (!body) return null
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' } })
}
