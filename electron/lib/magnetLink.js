// electron/lib/magnetLink.js
//
// Pure helpers for detecting/extracting magnet: URIs from `open-url` events
// and argv arrays (Windows/Linux first-launch and `second-instance` argv).
// No Electron dependency — importable/testable directly.

/** True if `value` is a string that literally starts with "magnet:". */
export function isMagnetUri(value) {
  return typeof value === 'string' && value.startsWith('magnet:')
}

/**
 * Scan a `process.argv`-shaped array for the first token that is a magnet
 * URI. Returns null if none found.
 *
 * Deliberately strict (`startsWith('magnet:')` only, via `isMagnetUri`) so
 * it never misfires on the app's own executable path, the script path, or
 * `--flag`/`--flag=value` style dev/Electron/Chromium arguments (e.g.
 * `--inspect`, `--original-process-start-time=...`) — none of those can
 * ever literally start with "magnet:".
 */
export function parseMagnetFromArgv(argv) {
  if (!Array.isArray(argv)) return null
  return argv.find((arg) => isMagnetUri(arg)) ?? null
}
