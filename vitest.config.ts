import { defineConfig } from 'vitest/config'

/**
 * The package owns its toolchain and harness devDependencies, so the suite
 * runs from a standalone clone: no DSH checkout path, path aliases, or parent
 * layout is consulted. Tests that need a checkout's own build use
 * `npm run link` first.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.e2e.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
