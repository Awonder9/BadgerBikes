// Minimal stand-in for the `cloudflare:workers` module so Worker modules load in Node-based Vitest.
// Only what the app imports is provided; behavior lives in pure, separately tested cores.
export class DurableObject<E = unknown> {
  protected ctx: unknown
  protected env: E
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx
    this.env = env
  }
}
