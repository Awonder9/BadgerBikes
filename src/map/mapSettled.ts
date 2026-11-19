// Resolves once the map has drawn for the first time (its style and first tiles), or can't (no WebGL2, or its
// code didn't download). Startup work that can wait — the service worker's precache, which would download the
// ~1.5 MB map runtime a second time while the page is still fetching it — waits for this (AppShell).
let settle: () => void = () => {}

export const mapSettled: Promise<void> = new Promise((resolve) => {
  settle = resolve
})

/** Called by MapView. Only the first call counts. */
export function markMapSettled(): void {
  settle()
}
