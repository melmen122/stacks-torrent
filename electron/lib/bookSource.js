// Pure helper for building a book's `source` provenance field (see
// docs/models.md's `Book.source`) from a torrent's layer-1 safety
// classification (electron/lib/safetyCheck.js's `classifyTorrentFiles`
// result). Extracted so the shape + the skipped-list cap can be
// unit-tested without a real webtorrent client.
//
// Why this matters: VirusTotal (layer 2) returns 'unknown' for essentially
// every audiobook — personal rips are never in VT's database — so layer 1
// (torrent-manifest classification: were there any executables/archives/
// disguised files bundled alongside the audio, and were they kept off
// disk?) is the only genuine, positive safety signal available for a book.
// Persisting it onto the book at import time (rather than leaving it to
// live only on the transient torrents:list entry) gives the renderer real
// provenance to show an honest "audio-only download" badge instead of
// nothing.

/** Caps the persisted `skipped` list so a pathological torrent (thousands
 * of bundled junk files) can't bloat library.json indefinitely. The full
 * count is still preserved via `skippedCount`, which is NOT capped. */
export const MAX_SOURCE_SKIPPED_ENTRIES = 50

/**
 * @param {string} infoHash
 * @param {{verdict: string, hasAudio: boolean, skipped: Array<{name: string, category: string, reason: string}>}} report
 *   - the same classification report `torrents.js` already stores in its
 *     `safetyReports` WeakMap (classifyTorrentFiles's return value).
 * @param {number} [importedAt] - defaults to `Date.now()`.
 * @returns {{type: 'torrent', infoHash: string, safety: {verdict: string, hasAudio: boolean, skippedCount: number, skipped: Array}, importedAt: number}}
 */
export function buildTorrentSource(infoHash, report, importedAt = Date.now()) {
  const skipped = Array.isArray(report?.skipped) ? report.skipped : []
  return {
    type: 'torrent',
    infoHash,
    safety: {
      verdict: report?.verdict ?? 'unknown',
      hasAudio: !!report?.hasAudio,
      // Full count, uncapped — the cap below only bounds how many detailed
      // entries are persisted, not the number the UI can report as blocked.
      skippedCount: skipped.length,
      skipped: skipped
        .slice(0, MAX_SOURCE_SKIPPED_ENTRIES)
        .map((entry) => ({ name: entry.name, category: entry.category, reason: entry.reason }))
    },
    importedAt
  }
}

/** Provenance for a book added via manual import / drag & drop: the user
 * supplied the files directly, so there's no torrent manifest to classify
 * and no safety verdict is invented for it. Distinct from a book with no
 * `source` at all (a legacy book added before this field existed) — the
 * renderer can tell "known import, no verdict" apart from "unknown
 * provenance" this way. */
export function buildImportSource(importedAt = Date.now()) {
  return { type: 'import', importedAt }
}
