import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../vitest.shared.ts'

/**
 * The test config lives beside the prototype but resolves the harness through
 * the checkout root's TypeScript source paths, exactly like the repository's
 * own suites. `root` is pinned to the checkout so the command works from any
 * working directory.
 */
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../tsconfig.base.json', import.meta.url))] }), standardDecoratorPlugin()],
  test: {
    include: ['new-linux-sandbox/tests/**/*.spec.ts', 'new-linux-sandbox/tests/**/*.e2e.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
