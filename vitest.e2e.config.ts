import { defineConfig } from 'vitest/config'

// End-to-end tests spawn the built CLI (`dist/cli/main.js`); run
// `npm run build` first. `npm test` (vitest.config.ts) never needs a build.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
})
