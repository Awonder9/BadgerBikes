// A city's trails and scenic places for "Just ride" (src/data/scenic/<system id>.json, `npm run update-scenic`).
// Each city's file is its own lazily loaded chunk (vite.config.ts names them scenic-*, left out of the service
// worker's precache), fetched the first time a loop is planned there. A city without a file (or one that fails to
// load) has no scenery: loops are still planned, through geometric waypoints on bike-friendly streets.
import { parseScenic, type ScenicPoint } from '../routing/scenic'

const files = import.meta.glob<{ default: unknown }>('./scenic/*.json')
const loaded = new Map<string, Promise<ScenicPoint[]>>()

export function loadScenic(systemId: string): Promise<ScenicPoint[]> {
  let p = loaded.get(systemId)
  if (!p) {
    const load = files[`./scenic/${systemId}.json`]
    p = load
      ? load().then(
          (m) => parseScenic(m.default),
          () => {
            loaded.delete(systemId) // a failed chunk download (offline) is tried again next time
            return []
          },
        )
      : Promise.resolve([])
    loaded.set(systemId, p)
  }
  return p
}
