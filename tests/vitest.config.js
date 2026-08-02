// Vitest config for the pure-node test suite in tests/.
//
// The app's vite.config.js sets `root: src/renderer` (for the renderer
// bundle), which would make a bare `vitest run` look for tests in the
// renderer directory and find none. This config re-anchors vitest at the
// repo root and scopes it to tests/**. Referenced explicitly from the
// `test` script in package.json (`vitest run --config tests/vitest.config.js`).

import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export default defineConfig({
  root: repoRoot,
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js']
  }
})
