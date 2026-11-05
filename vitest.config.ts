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
const checkout = fileURLToPath(new URL('..', import.meta.url))

/**
 * The package is not a pnpm workspace member, so browser-test dependencies
 * (React, YAML) resolve from the checkout package that owns them rather than
 * from a local node_modules.
 */
const aliases = {
  react: fileURLToPath(new URL('../packages/client/ui-primitives/node_modules/react', import.meta.url)),
  'react-dom': fileURLToPath(new URL('../packages/client/ui-primitives/node_modules/react-dom', import.meta.url)),
  'js-yaml': fileURLToPath(new URL('../vendor/include/node_modules/js-yaml', import.meta.url)),
  semver: fileURLToPath(new URL('../node_modules/semver', import.meta.url)),
}

export default defineConfig({
  root: checkout,
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../tsconfig.base.json', import.meta.url))] }), standardDecoratorPlugin()],
  resolve: { alias: aliases },
  test: {
    include: ['dsh-configurable-linux-sandbox/tests/**/*.spec.ts', 'dsh-configurable-linux-sandbox/tests/**/*.e2e.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
