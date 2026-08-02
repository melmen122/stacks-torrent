// electron/lib/mediaRange.js
//
// Pure HTTP Range header parsing for the media:// protocol's byte-range
// support (needed for <audio> seeking). No Electron/`app` dependency —
// importable directly in tests.

/**
 * Parse a `Range` request header against a resource of the given size.
 *
 * @param {string|null|undefined} rangeHeader - raw header value, e.g. "bytes=0-499".
 * @param {number} size - total size of the resource in bytes.
 * @returns {null | { start: number, end: number } | { unsatisfiable: true }}
 *   `null` means "no range requested" (caller should serve the whole file).
 *   `{ unsatisfiable: true }` means the caller should respond 416.
 */
export function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null

  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
  if (!match) return { unsatisfiable: true }

  const hasStart = match[1] !== ''
  const hasEnd = match[2] !== ''
  let start
  let end

  if (!hasStart && hasEnd) {
    // Suffix range, e.g. "bytes=-500" means "the last 500 bytes".
    const suffixLength = parseInt(match[2], 10)
    start = Math.max(size - suffixLength, 0)
    end = size - 1
  } else {
    start = hasStart ? parseInt(match[1], 10) : 0
    end = hasEnd ? parseInt(match[2], 10) : size - 1
  }

  if (Number.isNaN(start) || start < 0) start = 0
  if (Number.isNaN(end) || end > size - 1) end = size - 1

  if (start > end || start >= size) {
    return { unsatisfiable: true }
  }

  return { start, end }
}
