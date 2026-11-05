import { defineConfig } from 'tsdown'

/** Browser modules the Web shell seeds; every other import must be inlined. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/**
 * Two faces: one bundled ESM Host entry (`lib/index.js`) that mounts the core,
 * sandbox, and filesystem plugins, and one CJS closure-factory Client bundle
 * (`lib/client.js`) in the shape the Web shell's module loader expects.
 *
 * Harness packages and `zod` stay external for the Host face; the Client face
 * externalizes only the shell's platform module table.
 */
export default defineConfig([
  {
    entry: { index: 'lib/types/index.js' },
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
  },
  {
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: PLATFORM_MODULES,
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-configurable-linux-sandbox", factory: (require) => {',
      intro: 'var module = { exports: {} };\nvar exports = module.exports;',
      footer: 'return module.exports;\n} });',
    },
  },
])
