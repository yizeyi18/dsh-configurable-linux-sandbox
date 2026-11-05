import { defineConfig } from 'tsdown'

/**
 * Bundle the JavaScript that `tsc -b` emitted into `lib/types/` as the single
 * ESM plugin entry. Harness packages, `zod`, and `@deepseek-ai/schemastery`
 * stay external: an installing profile resolves them from its own dependency
 * tree. `clean` stays off so the declaration output survives the bundle.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, 'zod'],
  },
})
