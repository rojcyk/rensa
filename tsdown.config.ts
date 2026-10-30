import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

const shared = {
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  shims: false,
  fixedExtension: false,
  sourcemap: true,
  define: { __RENSA_VERSION__: JSON.stringify(pkg.version) },
} as const

export default defineConfig([
  {
    ...shared,
    entry: { 'cli/main': 'src/cli/main.ts' },
    dts: false,
    clean: true,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    ...shared,
    entry: { 'engine/index': 'src/engine/index.ts' },
    dts: true,
    clean: false,
  },
])
