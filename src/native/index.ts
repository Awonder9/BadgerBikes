// The iOS/Android apps' native features (docs/ARCHITECTURE.md §12). Their plugins are a chunk of their own,
// loaded here on first use; call this only inside the apps (isNativeApp() in src/ui/platform.ts).
type Plugins = typeof import('./plugins')

let loading: Promise<Plugins> | null = null

export function nativePlugins(): Promise<Plugins> {
  loading ??= import('./plugins').catch((err: unknown) => {
    loading = null // the chunk is on the phone, but a failed load may still be retried
    throw err
  })
  return loading
}
