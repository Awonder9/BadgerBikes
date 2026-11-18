import { describe, expect, it } from 'vitest'

// maplibre-gl is about two thirds of the app's code and is loaded on demand through src/map/maplibre.ts. Any
// other runtime import of it — even `import { type X }`, which still leaves an import behind, or a `?url` file
// import — puts it back into the startup bundle, delaying the first paint and the first station counts.
const sources = import.meta.glob<string>(['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts', '!../**/*.test.tsx'], { query: '?raw', import: 'default', eager: true })

/** Runtime (non-`import type`) imports and re-exports of maplibre-gl or any of its files. */
function runtimeMaplibreImports(code: string): string[] {
  const found: string[] = []
  for (const m of code.matchAll(/\b(import|export)\s+(type\s+)?[^'";]*?\bfrom\s*['"](maplibre-gl[^'"]*)['"]/g)) if (!m[2]) found.push(m[3]!)
  for (const m of code.matchAll(/\bimport\s*\(?\s*['"](maplibre-gl[^'"]*)['"]/g)) found.push(m[1]!)
  return found
}

describe('the map runtime stays out of the startup bundle', () => {
  it('recognizes runtime imports but not type-only ones', () => {
    expect(runtimeMaplibreImports(`import type { Map } from 'maplibre-gl'`)).toEqual([])
    expect(runtimeMaplibreImports(`import { type Map } from 'maplibre-gl'`)).toEqual(['maplibre-gl'])
    expect(runtimeMaplibreImports(`import url from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'`)).toEqual(['maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'])
    expect(runtimeMaplibreImports(`import 'maplibre-gl/dist/maplibre-gl.css'`)).toEqual(['maplibre-gl/dist/maplibre-gl.css'])
  })

  it('only src/map/maplibre.ts imports maplibre-gl at runtime (everything else uses import type)', () => {
    // Glob keys are relative to this file ('./MapView.tsx', '../App.tsx'): resolve them to '/src/…'.
    const files = Object.entries(sources).map(([key, code]) => ({ path: new URL(key, 'file:///src/map/').pathname, code }))
    expect(files.length).toBeGreaterThan(50) // the glob really covers src/
    expect(files.map((f) => f.path)).toContain('/src/map/MapView.tsx')
    const offenders = files.filter((f) => f.path !== '/src/map/maplibre.ts' && runtimeMaplibreImports(f.code).length > 0).map((f) => f.path)
    expect(offenders).toEqual([])
  })
})
