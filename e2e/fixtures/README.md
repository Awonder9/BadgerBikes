# E2E fixtures

`e2e/smoke.spec.ts` runs network-free: every external request is aborted and `/api/*` answers 503, so the
tests cover the shell, panels and first-run flow without live services. `tiles/` holds a minimal map style
and real Noto Sans glyph ranges (from OpenFreeMap, 2026-11-17) for future map-level tests.
