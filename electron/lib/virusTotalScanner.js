// electron/lib/virusTotalScanner.js
//
// Stateful orchestrator wiring the pure pieces (electron/lib/virusTotal.js:
// hashing + API + verdict mapping; electron/lib/scanQueue.js: rate limiting;
// electron/lib/virusTotalCache.js: persistent cache) into the actual
// "scan a book's audio files, update library.json, broadcast progress/
// completion" flow (docs/PLAN4B.md). Depends on `library` (an
// electron/lib/library.js store instance) and `getWindow` for broadcasting
// — nothing here touches `electron.app` directly; paths and a settings
// getter are passed in.
//
// Two independent levels of sequencing, both intentional (docs/PLAN4B.md
// "Hashing ... run it sequentially in the background"):
//   1. Books are scanned ONE AT A TIME (`bookQueue` below) — hashing a
//      multi-file audiobook is real CPU/IO work; scanning several books in
//      parallel would multiply that for no benefit, since VT lookups are
//      rate-limited globally anyway.
//   2. Within one book, files are hashed in a plain sequential loop (no
//      Promise.all), and each hash's VT lookup goes through the shared
//      `scanQueue` (electron/lib/scanQueue.js), which rate-limits and
//      dedupes across ALL books' lookups together.

import path from 'node:path'
import { hashFile, lookupHash, mapVerdict } from './virusTotal.js'
import { createScanQueue } from './scanQueue.js'
import { loadVirusTotalCache, saveVirusTotalCache, isCacheEntryFresh } from './virusTotalCache.js'

/**
 * @param {object} deps
 * @param {import('./library.js').ReturnType<typeof createLibraryStore>} deps.library
 * @param {() => import('electron').BrowserWindow|null} deps.getWindow
 * @param {() => {virusTotalEnabled: boolean, virusTotalApiKey: string|null}} deps.getSettings
 * @param {string} [deps.cacheFilePath] - path to userData/vt-cache.json.
 *   Cache persistence is a no-op if omitted (keeps this constructible in
 *   simple tests without needing real userData paths).
 * @param {typeof fetch} [deps.fetchImpl] - forwarded to `lookupHash`;
 *   injectable so tests never hit the real network.
 * @param {{now:Function, setTimeout:Function, clearTimeout:Function}} [deps.clock]
 *   forwarded to the internal rate-limit queue (electron/lib/scanQueue.js);
 *   injectable so tests can drive multi-request rate-limiting/backoff
 *   deterministically instead of waiting on real timers.
 */
export function createVirusTotalScanner({ library, getWindow, getSettings, cacheFilePath, fetchImpl, clock }) {
  let cache = {}
  let cacheLoaded = false

  async function ensureCacheLoaded() {
    if (cacheLoaded) return
    if (cacheFilePath) {
      cache = await loadVirusTotalCache(cacheFilePath).catch((err) => {
        console.error('[virusTotal] failed to read vt-cache.json:', err?.message)
        return {}
      })
    }
    cacheLoaded = true
  }

  async function persistCache() {
    if (!cacheFilePath) return
    try {
      await saveVirusTotalCache(cacheFilePath, cache)
    } catch (err) {
      console.error('[virusTotal] failed to persist vt-cache.json:', err?.message)
    }
  }

  const queue = createScanQueue({
    clock,
    performLookup: (sha256) => {
      const settings = getSettings?.() ?? {}
      return lookupHash(sha256, settings.virusTotalApiKey, { fetchImpl })
    }
  })

  /**
   * Reconstructs a `lookupHash()`-shaped result from a cache entry such
   * that `mapVerdict(reconstructed) === cached.verdict` EXACTLY, for every
   * stored verdict. This is the ONLY place a cache hit produces a result —
   * routing every cache hit through this one faithful reconstruction makes
   * it structurally impossible for a cached verdict to change meaning on
   * replay, rather than relying on every caller to remember a special case.
   *
   * The one verdict that CANNOT be reconstructed from `{malicious,
   * suspicious}` alone is `'unknown'`: a 404 (file never seen by VT) is
   * cached with `malicious: 0, suspicious: 0` (there are no real stats to
   * store), which is numerically IDENTICAL to a genuinely clean file's
   * `{malicious: 0, suspicious: 0}`. Blindly replaying either as
   * `{status: 'known', malicious: 0, suspicious: 0}` would make
   * `mapVerdict` return `'clean'` for both — silently turning "VirusTotal
   * has never seen this file" into a false "Clean" badge, which breaks the
   * PLAN4B honesty constraint that `unknown` must never render as safe.
   * `cached.verdict` is checked FIRST, before ever falling through to the
   * numeric reconstruction, specifically to prevent that collision.
   */
  function reconstructLookupResult(cached) {
    if (cached.verdict === 'unknown') return { status: 'unknown' }
    return {
      status: 'known',
      malicious: cached.malicious ?? 0,
      suspicious: cached.suspicious ?? 0
    }
  }

  /** Cache-then-queue lookup for one hash. Writes fresh results to the
   * persistent cache; never re-looks-up a still-fresh cached hash. */
  async function lookupWithCache(sha256) {
    await ensureCacheLoaded()
    const cached = cache[sha256]
    if (isCacheEntryFresh(cached)) {
      return reconstructLookupResult(cached)
    }

    const result = await queue.enqueue(sha256)
    if (result.status === 'known' || result.status === 'unknown') {
      cache[sha256] = {
        verdict: mapVerdict(result),
        malicious: result.malicious ?? 0,
        suspicious: result.suspicious ?? 0,
        checkedAt: Date.now()
      }
      await persistCache()
    }
    return result
  }

  function broadcastProgress(bookId, done, total) {
    const win = getWindow?.()
    if (!win || win.isDestroyed()) return
    win.webContents.send('virusTotal:scan-progress', { bookId, done, total })
  }

  function broadcastComplete(bookId, verdict, infectedFiles) {
    const win = getWindow?.()
    if (!win || win.isDestroyed()) return
    win.webContents.send('virusTotal:scan-complete', { bookId, verdict, infectedFiles })
  }

  function broadcastLibraryChanged() {
    const win = getWindow?.()
    if (!win || win.isDestroyed()) return
    win.webContents.send('library:changed')
  }

  // Book-level sequencing state (level 1 above).
  const scanningBookIds = new Set()
  const bookQueue = []
  let processingBooks = false

  function isVirusTotalReady() {
    const settings = getSettings?.() ?? {}
    return !!settings.virusTotalEnabled && !!settings.virusTotalApiKey
  }

  /**
   * Queue a book for scanning (or re-scanning). Fire-and-forget: resolves
   * immediately with `{queued: true}` once accepted; actual progress/result
   * arrive via `virusTotal:scan-progress`/`virusTotal:scan-complete`.
   */
  async function scanBook(bookId) {
    if (!isVirusTotalReady()) return { queued: false }

    const book = library.findBook(bookId)
    if (!book || !Array.isArray(book.files) || !book.files.length) return { queued: false }

    if (scanningBookIds.has(bookId)) return { queued: true }
    scanningBookIds.add(bookId)
    bookQueue.push(bookId)
    processBookQueue().catch((err) => {
      console.error('[virusTotal] book scan queue processing failed:', err?.message)
    })
    return { queued: true }
  }

  async function processBookQueue() {
    if (processingBooks) return
    processingBooks = true
    try {
      while (bookQueue.length) {
        const bookId = bookQueue.shift()
        const book = library.findBook(bookId)
        if (book) {
          try {
            await runScan(book)
          } catch (err) {
            console.error('[virusTotal] scan failed for book', bookId, ':', err?.message)
          }
        }
        scanningBookIds.delete(bookId)
      }
    } finally {
      processingBooks = false
    }
  }

  async function runScan(book) {
    const total = book.files.length

    await library.setBookScan(book.id, { state: 'scanning', verdict: null, scannedAt: null, files: [] }).catch((err) => {
      console.error('[virusTotal] failed to mark book scanning:', err?.message)
    })
    broadcastLibraryChanged()
    broadcastProgress(book.id, 0, total)

    const results = []
    let done = 0
    let authFailed = false
    // A transient failure (network/hashing error on one file — NOT an
    // auth failure, which aborts the whole scan above) must not bake in
    // permanently: that file's verdict degrades to 'unknown' for THIS run,
    // but the book is persisted as state:'error' (not 'done') below so
    // `isBookScanStale` re-queues it on next startup instead of treating a
    // momentary blip as a fresh, trustworthy 30-day result.
    let hadTransientError = false

    for (const filePath of book.files) {
      if (authFailed) break

      let sha256 = null
      let lookup
      try {
        sha256 = await hashFile(filePath)
        lookup = await lookupWithCache(sha256)
      } catch (err) {
        console.error('[virusTotal] failed to hash/lookup a file during scan:', err?.message)
        lookup = { status: 'error', message: 'internal error' }
      }

      if (lookup.status === 'auth-error') {
        authFailed = true
        break
      }
      if (lookup.status === 'error') {
        hadTransientError = true
      }

      const verdict = lookup.status === 'known' || lookup.status === 'unknown' ? mapVerdict(lookup) : 'unknown'
      results.push({
        name: path.basename(filePath),
        sha256,
        verdict,
        malicious: lookup.malicious ?? 0,
        suspicious: lookup.suspicious ?? 0
      })
      done += 1
      broadcastProgress(book.id, done, total)
    }

    // The book may have been removed from the library while this scan was
    // running (hashing/lookups can take a while). Don't persist anything
    // for it, and don't broadcast a completion event carrying its bookId —
    // the renderer has nothing to attach that to and would otherwise write
    // a "ghost" override for a book that no longer exists.
    if (!library.findBook(book.id)) return

    if (authFailed) {
      await library.setBookScan(book.id, { state: 'error', verdict: null, scannedAt: Date.now(), files: results }).catch((err) => {
        console.error('[virusTotal] failed to persist scan error state:', err?.message)
      })
      broadcastLibraryChanged()
      return
    }

    const overallVerdict = results.some((r) => r.verdict === 'infected')
      ? 'infected'
      : results.some((r) => r.verdict === 'suspicious')
        ? 'suspicious'
        : results.length > 0 && results.every((r) => r.verdict === 'clean')
          ? 'clean'
          : 'unknown'

    await library
      .setBookScan(book.id, {
        state: hadTransientError ? 'error' : 'done',
        verdict: overallVerdict,
        scannedAt: Date.now(),
        files: results
      })
      .catch((err) => {
        console.error('[virusTotal] failed to persist scan result:', err?.message)
      })
    broadcastLibraryChanged()

    const infectedFiles = results.filter((r) => r.verdict === 'infected').map((r) => ({ name: r.name, malicious: r.malicious }))
    broadcastComplete(book.id, overallVerdict, infectedFiles)
  }

  /**
   * Called once at bootstrap: enqueue every book whose scan is missing or
   * stale, bounded naturally by the shared rate-limited queue + sequential
   * book processing above (nothing here fans out unboundedly). No-ops
   * entirely if VirusTotal isn't enabled/configured.
   */
  function enqueueStaleBooks() {
    if (!isVirusTotalReady()) return
    const { books } = library.list()
    for (const book of books) {
      if (isBookScanStale(book)) {
        scanBook(book.id).catch((err) => {
          console.error('[virusTotal] failed to enqueue stale book on startup:', err?.message)
        })
      }
    }
  }

  function isBookScanStale(book) {
    const scan = book?.scan
    if (!scan) return true
    if (scan.state === 'error') return true
    if (scan.state === 'scanning') return true // interrupted mid-scan by a previous quit — retry
    if (scan.state === 'done') return !isCacheEntryFresh({ checkedAt: scan.scannedAt })
    return true
  }

  function destroy() {
    queue.destroy()
  }

  return { scanBook, enqueueStaleBooks, destroy }
}
