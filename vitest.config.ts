import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Standalone (not merged with vite.config.ts) so unit tests never boot the Cloudflare runtime.
// @cloudflare/vitest-pool-workers does not support Vitest 5 yet, so Worker code is tested in Node:
// pure cores are tested directly, and `cloudflare:workers` resolves to a tiny stub.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./worker/test/cloudflareWorkersStub.ts', import.meta.url)),
    },
  },
  test: {
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'worker/**/*.test.ts', 'scripts/**/*.test.mjs'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.test.tsx'],
        },
      },
    ],
  },
})
