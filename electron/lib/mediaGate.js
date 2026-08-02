// electron/lib/mediaGate.js
//
// Pure path-gating logic for the media:// protocol: given a requested
// (already decoded) filesystem path and the app's covers directory, decides
// whether serving that file is allowed. No Electron/`app` dependency —
// importable directly in tests with an arbitrary temp "covers dir".

import path from 'node:path'
import { ALLOWED_AUDIO_EXTENSIONS } from './metadata.js'

/**
 * @param {string} requestedPath - absolute filesystem path (already decoded).
 * @param {string} coversDir - absolute path to the covers directory.
 * @returns {{ allowed: boolean, resolvedPath: string, ext: string }}
 */
export function resolveMediaAccess(requestedPath, coversDir) {
  const resolvedPath = path.resolve(path.normalize(requestedPath))
  const resolvedCovers = path.resolve(coversDir)
  const ext = path.extname(resolvedPath).toLowerCase()

  // Boundary check deliberately includes the path separator so a sibling
  // directory that merely *starts with* the covers dir's name (e.g.
  // "<userData>/covers-evil/x") is never mistaken for being inside it.
  const withinCovers =
    resolvedPath === resolvedCovers || resolvedPath.startsWith(resolvedCovers + path.sep)
  const isAllowedAudio = ALLOWED_AUDIO_EXTENSIONS.includes(ext)

  return {
    allowed: isAllowedAudio || withinCovers,
    resolvedPath,
    ext
  }
}
