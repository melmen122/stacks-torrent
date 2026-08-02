// scripts/start-dev.cjs
//
// Cross-platform launcher used only by `npm run dev`. Sets
// VITE_DEV_SERVER_URL in the child process's environment (portably, without
// relying on shell-specific `VAR=value cmd` syntax that Windows cmd.exe
// doesn't support) so electron/main.js knows to load the Vite dev server.
// `npm start` and packaged builds never set this env var and always load
// dist/index.html.
'use strict'

const { spawn } = require('node:child_process')
const electronPath = require('electron')

const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl }
})

child.on('close', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('[dev] failed to launch electron:', err)
  process.exit(1)
})
