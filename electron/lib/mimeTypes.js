// electron/lib/mimeTypes.js
//
// Shared audio/image extension -> MIME type mapping. Used by both the
// `media://` protocol (electron/main.js, for the desktop renderer) and the
// phone HTTP server (electron/lib/phoneServer.js, for `/cover` and
// `/media`) so the two never drift apart.

/**
 * @param {string} ext - lowercased extension including the leading dot
 *   (e.g. ".mp3").
 * @returns {string} MIME type, or "application/octet-stream" if unknown.
 */
export function mimeTypeFor(ext) {
  switch (ext) {
    case '.mp3':
      return 'audio/mpeg'
    case '.m4a':
    case '.m4b':
      return 'audio/mp4'
    case '.aac':
      return 'audio/aac'
    case '.flac':
      return 'audio/flac'
    case '.ogg':
    case '.opus':
      return 'audio/ogg'
    case '.wav':
      return 'audio/wav'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    default:
      return 'application/octet-stream'
  }
}
