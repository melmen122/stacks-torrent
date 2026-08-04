// electron/lib/torrents.js
//
// webtorrent (ESM) client wrapper. Runs in the main process. Depends on
// `library` (an electron/lib/library.js store instance) and `coversDir` for
// auto-import on completion, plus a `getWindow` callback used to broadcast
// progress/events — nothing here touches `electron.app` directly so the
// factory can be constructed with plain paths/values.
//
// NOTE: pinned to webtorrent ^3.0.16, not v2 as originally planned. Every
// webtorrent 2.8.x release (up to and including 2.8.5, the latest 2.x) is
// unconditionally broken against the parse-torrent ^11.0.18 it declares as
// its own dependency: webtorrent's Torrent#_onTorrentId does
// `arr2hex(parsedTorrent.infoHash)`, but parse-torrent 11.x's `infoHash` is
// already a hex *string* (raw bytes are in `infoHashBuffer`), so `arr2hex`
// (which expects a TypedArray) throws synchronously inside an un-awaited
// async method, crashing the whole process as an unhandled rejection on
// literally every `client.add()` call — magnet or .torrent file, verified
// with real, well-known info hashes. webtorrent 3.0.16 fixes this (verified
// directly against its installed source) and its `add`/`remove`/`get`/
// `pause`/`resume`/property surface used here is otherwise identical to 2.x.
//
// Pre-download safety check (docs/PLAN4.md): every torrent is added with
// `{ deselect: true }` — verified directly against installed source
// (lib/torrent.js `_onMetadata`) that this sets `_startAsDeselected = true`,
// which skips webtorrent's normal "select the entire torrent" default
// entirely; NOTHING is selected until we explicitly call `file.select()`.
// Selection happens on the torrent's 'metadata' event (fires for BOTH local
// .torrent-file adds and, critically, magnet URIs once peers deliver the
// file list — verified this is the same `_onMetadata` codepath for both),
// which itself fires *before* webtorrent opens its chunk store or begins
// verifying/fetching any piece — so our synchronous classify-then-select
// callback is guaranteed to run before any piece-fetching machinery for
// this torrent exists. Only classified-audio files (and small selectable
// cover images, docs/PLAN4B.md) ever get `.select()`ed; everything else
// stays deselected for the torrent's whole lifetime, so its pieces are
// never REQUESTED from peers.
//
// That is not the same as "never WRITTEN to disk": webtorrent's chunk store
// writes each downloaded piece's bytes to EVERY file that piece overlaps,
// selected or not — selection governs requesting, not writing. A piece
// needed for a selected audio file can also overlap an adjacent deselected
// file, and since an attacker controls both file order and piece length
// when authoring a torrent, a small malicious file can be crafted to land
// entirely within one such boundary piece and be written to disk IN FULL
// the moment that piece completes — not just a harmless fragment. See
// `cleanupSkippedFiles` (called both at classification time, for leftover
// fragments from a prior session, AND again once audio download completes,
// which is the call that actually matters) for how this is closed in
// practice.
//
// IMPORTANT consequence: `torrent.done`/the torrent's own 'done' event
// require *every* file (selected or not) to finish — verified in
// `_checkDone` (`this.files.every(file => file.done)`) — so with
// intentionally-deselected non-audio files, the built-in 'done' event would
// simply never fire. Completion is instead tracked per selected audio
// `File` object's own 'done' event (see `attachAudioCompletionTracking`).

import path from 'node:path'
import { promises as fs } from 'node:fs'
import WebTorrent from 'webtorrent'
import { scanBookFiles, isAudioFile } from './metadata.js'
import { loadPersistedTorrents, savePersistedTorrents } from './torrentPersistence.js'
import { classifyTorrentFiles } from './safetyCheck.js'

const PROGRESS_INTERVAL_MS = 1000

/**
 * @param {object} deps
 * @param {import('./library.js').ReturnType<typeof createLibraryStore>} deps.library
 * @param {string} deps.coversDir - directory covers get extracted into.
 * @param {() => import('electron').BrowserWindow|null} deps.getWindow - returns
 *   the current main window (or null if none/destroyed) for event broadcast.
 * @param {string} [deps.torrentsFilePath] - path to userData/torrents.json.
 *   Persistence is a no-op if omitted (keeps this constructible in simple
 *   tests without needing real userData paths).
 * @param {string} [deps.torrentFilesDir] - directory .torrent files get
 *   copied into on add, so re-adding after a restart doesn't depend on the
 *   original file (e.g. a Downloads-folder file) still existing.
 * @param {(book: object) => void} [deps.onBookImported] - called once, right
 *   after `handleDone` successfully adds a book to the library (docs/PLAN4B.md
 *   "after handleDone imports a book, enqueue ... for scanning"). Optional —
 *   wired by main.js to the VirusTotal scanner; a no-op if omitted.
 */
export function createTorrentManager({ library, coversDir, getWindow, torrentsFilePath, torrentFilesDir, onBookImported }) {
  const client = new WebTorrent({
    // No throttling exists anywhere in this app, and none may be added:
    // explicitly request unlimited download/upload rate (-1 is also
    // webtorrent's own default, but pass it explicitly so it can never be
    // silently inherited/changed) and raise the per-torrent max connection
    // count above the library default (55) so downloads aren't artificially
    // capped on peer-rich swarms.
    downloadLimit: -1,
    uploadLimit: -1,
    maxConns: 100
  })
  let progressTimer = null
  // Guards against classifying (and attaching audio-completion tracking to)
  // the same torrent instance more than once. webtorrent's own duplicate-add
  // detection invokes our `ontorrent` callback with the *pre-existing*
  // torrent object whenever a caller adds a magnet/torrent that's already
  // active, so without this a second `add()` for the same torrent could
  // re-run classification and stack a second completion listener, double
  // auto-importing the same completed book.
  const classifiedTorrents = new WeakSet()
  // Full classifyTorrentFiles() report per torrent (set once, on 'metadata').
  // Used to build `summarize()`'s trimmed `safety` field and the full
  // `torrents:safety-report` broadcast payload.
  const safetyReports = new WeakMap()
  // The selected (audio) webtorrent `File` objects per torrent, set once on
  // 'metadata' (empty array before classification, or if hasAudio is
  // false). `summarize()` uses this — NOT `torrent.progress`/`torrent.done`
  // — to report progress/completion; see the module header comment for why:
  // both of webtorrent's own torrent-level equivalents are computed against
  // ALL files, selected or not, so with intentionally-deselected non-audio
  // files they'd show a misleadingly low/stuck percentage and never reach
  // done at all.
  const audioFilesByTorrent = new WeakMap()
  // Sentinel: added once every selected audio file has individually
  // finished (see `attachAudioCompletionTracking`). This — not
  // `torrent.done` — is what `summarize()` reports as `done`.
  const audioDownloadComplete = new WeakSet()
  // Immutable-per-torrent bits of the persisted entry that can't be derived
  // from the live Torrent instance (its magnet/infoHash-or-copied-file
  // identity, the download dir it was originally added with, and when).
  // Live bits (`paused`, `done`) are read straight off the torrent at
  // persist time instead of being duplicated here.
  const persistMeta = new WeakMap()

  client.on('error', (err) => {
    // A client-level error (e.g. malformed magnet/torrent file) — surface in
    // the console; individual `add()` calls also reject via their own guard.
    console.error('[torrents] client error:', err?.message ?? err)
  })

  /**
   * Progress against the SELECTED audio files only, not `torrent.progress`
   * (computed against the whole torrent's length, including deselected
   * files) — see the `audioFilesByTorrent` comment above.
   */
  function computeAudioProgress(torrent) {
    const audioFiles = audioFilesByTorrent.get(torrent)
    if (!audioFiles || !audioFiles.length) return 0
    const totalLength = audioFiles.reduce((sum, f) => sum + f.length, 0)
    if (totalLength === 0) return 0
    const downloaded = audioFiles.reduce((sum, f) => sum + f.downloaded, 0)
    return downloaded / totalLength
  }

  function summarize(torrent) {
    const report = safetyReports.get(torrent)
    return {
      infoHash: torrent.infoHash,
      name: torrent.name,
      progress: computeAudioProgress(torrent),
      downloadSpeed: torrent.downloadSpeed,
      numPeers: torrent.numPeers,
      done: audioDownloadComplete.has(torrent),
      paused: !!torrent.paused,
      // null = metadata not yet arrived / still checking (renderer shows
      // "checking…"). Trimmed shape per docs/PLAN4.md's exact contract.
      safety: report
        ? { verdict: report.verdict, hasAudio: report.hasAudio, skippedCount: report.skipped.length }
        : null
    }
  }

  function list() {
    return client.torrents.map(summarize)
  }

  function broadcastProgress() {
    const win = getWindow?.()
    if (!win || win.isDestroyed()) return
    win.webContents.send('torrents:progress', list())
  }

  function ensureProgressLoop() {
    if (progressTimer) return
    // Intentionally broadcasts even when `client.torrents` is empty: this is
    // what allows `remove()`'s explicit broadcast (and any subsequent tick)
    // to deliver a final, empty `torrents:progress` list to the renderer so
    // a removed torrent doesn't linger as a ghost row.
    progressTimer = setInterval(() => {
      broadcastProgress()
    }, PROGRESS_INTERVAL_MS)
    if (typeof progressTimer.unref === 'function') progressTimer.unref()
  }

  function findTorrent(infoHash) {
    return client.torrents.find((t) => t.infoHash === infoHash) ?? null
  }

  function broadcastSafetyReport(torrent, report) {
    const win = getWindow?.()
    if (!win || win.isDestroyed()) return
    win.webContents.send('torrents:safety-report', {
      infoHash: torrent.infoHash,
      name: torrent.name,
      verdict: report.verdict,
      hasAudio: report.hasAudio,
      downloadedCount: report.audio.length,
      skipped: report.skipped
    })
  }

  /**
   * Best-effort deletion of any skipped (non-audio, non-cover) file that
   * nonetheless exists on disk. Selection governs what webtorrent
   * REQUESTS from peers, not what it WRITES: a piece that overlaps both a
   * selected audio file and an adjacent deselected file still gets fetched
   * (because the audio file needs it) and the chunk store fans that piece's
   * bytes out to EVERY file it overlaps, selected or not — so a skipped
   * file sharing a boundary piece with a selected file WILL have bytes
   * written to it. This is not bounded to "a few incidental bytes": the
   * attacker controls both file order and piece length when authoring a
   * torrent, so a small malicious file (e.g. a tiny .exe) can be crafted to
   * land entirely within one such boundary piece and be written to disk
   * IN FULL the moment that piece completes. Never touches the covers this
   * torrent selected (docs/PLAN4B.md) — those are meant to be on disk.
   *
   * Called twice, deliberately: once at classification time (metadata) —
   * mostly a no-op for a fresh add (nothing has been fetched yet), but it
   * cleans up leftover fragments from a *previous* session on restore — and
   * again once audio download completes (`attachAudioCompletionTracking`'s
   * `finish`), which is the call that actually matters: only by then have
   * any boundary-piece-driven writes to skipped files actually happened.
   */
  async function cleanupSkippedFiles(torrent, report) {
    const coverNames = new Set((report.covers ?? []).map((f) => f.name))
    await Promise.all(
      report.skipped
        .filter((entry) => !coverNames.has(entry.name))
        .map(async (entry) => {
          const filePath = path.join(torrent.path, entry.name)
          await fs.unlink(filePath).catch(() => {})
        })
    )
  }

  /**
   * Tracks completion of only the SELECTED audio files (see the module
   * header comment for why `torrent.done`/'done' can't be used here: they
   * require every file, selected or not, to finish). Once every audio
   * `File` has individually emitted 'done' (or already was done, e.g.
   * pre-existing verified local data on restore), marks
   * `audioDownloadComplete` (what `summarize()` reports as `done`), re-runs
   * `cleanupSkippedFiles` (this — not the metadata-time call — is what
   * actually deletes any boundary-piece spill, since only by now has any
   * fetching happened), and runs the same scan-and-import flow the old
   * torrent-level 'done' handler used to. Cleanup and import are
   * independent fire-and-forget calls, not sequenced: cleanup still runs
   * even if `handleDone` (book import) fails.
   */
  function attachAudioCompletionTracking(torrent, audioFiles) {
    if (!audioFiles.length) return
    let remaining = audioFiles.length
    const finish = () => {
      audioDownloadComplete.add(torrent)
      const report = safetyReports.get(torrent)
      if (report) {
        cleanupSkippedFiles(torrent, report).catch((err) => {
          console.error('[torrents] failed to clean up skipped files after audio completion:', err)
        })
      }
      handleDone(torrent)
    }
    const onOneDone = () => {
      remaining -= 1
      if (remaining <= 0) finish()
    }
    for (const file of audioFiles) {
      if (file.done) {
        remaining -= 1
      } else {
        file.once('done', onOneDone)
      }
    }
    if (remaining <= 0) finish()
  }

  /**
   * Runs once, on the torrent's 'metadata' event (file list known — see the
   * module header comment for why this is the correct, leak-proof point for
   * BOTH magnet and .torrent-file adds). Classifies the manifest, selects
   * only audio files for download (everything else stays deselected for the
   * torrent's whole lifetime), stores + broadcasts the safety report, and
   * — only if there's audio to wait for — starts tracking its completion.
   */
  function classifyAndSelect(torrent) {
    if (classifiedTorrents.has(torrent)) return
    classifiedTorrents.add(torrent)

    const manifest = torrent.files.map((f) => ({ name: f.path || f.name, length: f.length }))
    const report = classifyTorrentFiles(manifest)
    safetyReports.set(torrent, report)

    const audioNames = new Set(report.audio.map((f) => f.name))
    const audioFiles = torrent.files.filter((f) => audioNames.has(f.path || f.name))
    // Set unconditionally (even if empty) so `computeAudioProgress` always
    // has a definitive answer once classification has run, rather than
    // falling through to any stale/undefined state.
    audioFilesByTorrent.set(torrent, audioFiles)

    if (report.hasAudio) {
      for (const file of audioFiles) file.select()
      attachAudioCompletionTracking(torrent, audioFiles)

      // Also select small cover images (docs/PLAN4B.md). Still classified
      // and reported as 'companion' in `report.skipped` (never audio, never
      // imported as book content) — just additionally selected so
      // `scanBookFiles`' external-cover fallback has something to find.
      // Only done alongside real audio; a no-audio torrent selects nothing.
      const coverNames = new Set((report.covers ?? []).map((f) => f.name))
      if (coverNames.size) {
        const coverFiles = torrent.files.filter((f) => coverNames.has(f.path || f.name))
        for (const file of coverFiles) file.select()
      }
    }
    // No-audio guard: select nothing (not even covers). The torrent has no
    // selected pieces to ever fetch, so it correctly just sits at 0%
    // forever (no 'done' will ever fire) until the user removes it —
    // `summarize()`'s `safety.hasAudio: false` is what tells the renderer
    // to show that state and offer removal; we deliberately do NOT
    // auto-remove it here.

    cleanupSkippedFiles(torrent, report).catch((err) => {
      console.error('[torrents] failed to clean up skipped files:', err)
    })

    broadcastSafetyReport(torrent, report)
    persistNow().catch(() => {})
  }

  // ---------------------------------------------------------------------
  // Persistence (userData/torrents.json) — see docs/PLAN2.md.
  // ---------------------------------------------------------------------

  async function persistNow() {
    if (!torrentsFilePath) return
    const entries = client.torrents
      // Only exclude a torrent once it's BOTH done AND actually imported.
      // "Imported" is `meta.imported` (set by `handleDone` the moment its
      // `library.addBook` call succeeds) OR — belt-and-braces for entries
      // persisted by an older build without the flag — `library.findBook`.
      //
      // `meta.imported` must be checked FIRST and independently of
      // `findBook`: relying on `findBook` alone re-persists (and later
      // re-adds, re-downloads, and re-imports) a torrent whose book the
      // user deliberately removed from the library after it completed —
      // `findBook` would then (correctly, for the library) return null
      // again, but that must not resurrect the torrent. `meta.imported`
      // records the historical fact "this torrent's book was imported" and
      // never gets unset by a later library mutation.
      //
      // `handleDone`'s metadata scan can also take real time (seconds, for
      // a multi-file audiobook); if the app quits while that scan is still
      // in flight, the audio download is already complete but neither
      // `meta.imported` nor `findBook` is true yet. Excluding on completion
      // alone would flush a torrents.json that has already forgotten this
      // torrent, orphaning its downloaded files with no retry on next
      // launch. Keeping it persisted instead means next startup re-adds it,
      // webtorrent re-verifies the already-complete data on disk, audio
      // completion fires again, and `handleDone` (already idempotent via
      // its own findBook check) imports it — self-healing rather than
      // silently losing the book.
      //
      // Uses `audioDownloadComplete` (set once every SELECTED audio file is
      // done — see the module header comment), not `t.done`: webtorrent's
      // own `torrent.done` requires *every* file, selected or not, to
      // finish, so with any intentionally-deselected non-audio file (the
      // normal case) it would never become true, and this filter would
      // never exclude anything — permanently re-persisting (and re-adding
      // on every future restart) a torrent that's already been imported.
      .filter((t) => {
        const meta = persistMeta.get(t)
        const imported = !!meta?.imported || !!library.findBook(`b${t.infoHash.slice(0, 16)}`)
        return !(audioDownloadComplete.has(t) && imported)
      })
      .map((t) => {
        const meta = persistMeta.get(t)
        const report = safetyReports.get(t)
        return {
          magnetOrInfoHash: meta?.magnetOrInfoHash ?? t.infoHash,
          torrentFileCopyPath: meta?.torrentFileCopyPath ?? null,
          downloadDir: meta?.downloadDir ?? t.path,
          paused: !!t.paused,
          addedAt: meta?.addedAt ?? Date.now(),
          imported: !!meta?.imported,
          // Display-only convenience for an instant badge on next restore
          // (see `addInternal`'s `persistOverride?.safety` pre-population) —
          // re-classification on 'metadata' is always the source of truth.
          safety: report
            ? { verdict: report.verdict, hasAudio: report.hasAudio, skippedCount: report.skipped.length }
            : null
        }
      })
    try {
      await savePersistedTorrents(torrentsFilePath, entries)
    } catch (err) {
      console.error('[torrents] failed to persist torrents.json:', err)
    }
  }

  async function recordPersistMeta(torrent, idForClient, isMagnet, addedAt, persistOverride) {
    if (persistMeta.has(torrent)) return
    let torrentFileCopyPath = null
    let magnetOrInfoHash = torrent.infoHash

    if (persistOverride) {
      // Re-added from a previous session: keep the same identity we saved
      // (in particular, don't re-copy an already-copied .torrent file).
      torrentFileCopyPath = persistOverride.torrentFileCopyPath ?? null
      magnetOrInfoHash = persistOverride.magnetOrInfoHash ?? torrent.infoHash
    } else if (isMagnet) {
      magnetOrInfoHash = idForClient
    } else if (torrentFilesDir) {
      // Fresh add from a local .torrent file: copy it into userData/torrents/
      // so re-adding after a restart doesn't depend on the original file
      // (e.g. one picked from Downloads, which the user might later delete)
      // still existing at the same path.
      const dest = path.join(torrentFilesDir, `${torrent.infoHash}.torrent`)
      try {
        await fs.mkdir(torrentFilesDir, { recursive: true })
        await fs.copyFile(idForClient, dest)
        torrentFileCopyPath = dest
      } catch (err) {
        console.error('[torrents] failed to copy .torrent file for persistence:', err)
      }
    }

    persistMeta.set(torrent, {
      magnetOrInfoHash,
      torrentFileCopyPath,
      downloadDir: torrent.path,
      addedAt,
      // Carried through defensively — `restorePersisted` already skips any
      // entry with `imported: true` outright, so this should never actually
      // be true here, but preserves the flag rather than silently resetting
      // it if that ever changes.
      imported: !!persistOverride?.imported
    })
    await persistNow()
  }

  async function handleDone(torrent) {
    try {
      const audioFiles = torrent.files.filter((f) => isAudioFile(f.name))
      if (!audioFiles.length) return

      const filePaths = audioFiles.map((f) => path.join(torrent.path, f.path))
      // Restricted to the safety report's `covers` list — the small
      // image-extension files actually selected for download (docs/PLAN4B.md)
      // — rather than every non-audio file in the manifest. Anything else
      // (.exe, .dmg, archives, ...) was never selected/downloaded under
      // audio-only mode, so it wouldn't exist on disk to use as a cover
      // candidate anyway; restricting the candidate list itself is
      // defense-in-depth against ever handing a risky file path to the
      // cover extractor, independent of that.
      const report = safetyReports.get(torrent)
      const coverCandidates = (report?.covers ?? []).map((f) => path.join(torrent.path, f.name))

      const bookId = `b${torrent.infoHash.slice(0, 16)}`
      // Guards against re-importing the same torrent's book a second time —
      // e.g. if a user re-adds a magnet that already finished downloading in
      // a previous session, or audio-completion otherwise fires more than
      // once for the same torrent (defense in depth alongside
      // `attachAudioCompletionTracking`'s own per-torrent bookkeeping).
      if (library.findBook(bookId)) return
      const scanned = await scanBookFiles(filePaths, {
        bookId,
        coversDir,
        folderName: torrent.name,
        extraCoverCandidates: coverCandidates
      })

      if (!scanned.files.length) return

      const book = await library.addBook({
        id: bookId,
        title: scanned.title,
        author: scanned.author,
        files: scanned.files,
        coverPath: scanned.coverPath,
        durationSec: scanned.durationSec,
        suggestedGenre: scanned.suggestedGenre,
        chapters: scanned.chapters
      })

      // Record the historical fact that this torrent's book was imported,
      // independent of whether the book still exists in the library later
      // (the user may remove it afterwards) — see the `imported` comment in
      // `persistNow` for why this must not be re-derived from `findBook`.
      const meta = persistMeta.get(torrent)
      if (meta) {
        meta.imported = true
      } else {
        persistMeta.set(torrent, {
          magnetOrInfoHash: torrent.infoHash,
          torrentFileCopyPath: null,
          downloadDir: torrent.path,
          addedAt: Date.now(),
          imported: true
        })
      }

      const win = getWindow?.()
      if (win && !win.isDestroyed()) {
        win.webContents.send('torrents:done', {
          infoHash: torrent.infoHash,
          name: torrent.name,
          bookId: book.id
        })
        win.webContents.send('library:changed')
      }

      // docs/PLAN4B.md: enqueue for a VirusTotal scan (no-op if the caller
      // didn't wire this up, or if scanning is disabled — that check lives
      // entirely on the other side of this callback).
      try {
        onBookImported?.(book)
      } catch (err) {
        console.error('[torrents] onBookImported callback threw:', err)
      }
    } catch (err) {
      console.error('[torrents] failed to auto-import completed torrent:', err)
    } finally {
      // Re-persist so the snapshot reflects the outcome above: `persistNow`'s
      // own rule (done AND already in the library) means this torrent drops
      // out of torrents.json now that `library.addBook` above (if reached)
      // has made `library.findBook(bookId)` truthy. If this run didn't
      // reach `addBook` (no audio, or the scan/add itself failed), the
      // torrent stays persisted and will be retried on next startup.
      await persistNow().catch(() => {})
    }
  }

  /**
   * Shared implementation behind both the public `add()` and startup's
   * `restorePersisted()`.
   *
   * @param {string} idForClient - magnet URI, or a filesystem path to a
   *   .torrent file (fresh add), or a previously-copied .torrent file path
   *   (restore).
   * @param {string} downloadDir
   * @param {object} [restoreOpts]
   * @param {boolean} [restoreOpts.paused] - start paused (restoring a
   *   previously-paused torrent).
   * @param {object} [restoreOpts.persistOverride] - the persisted entry
   *   being restored, so its identity is preserved rather than regenerated.
   */
  function addInternal(idForClient, downloadDir, restoreOpts = {}) {
    const { paused = false, persistOverride = null } = restoreOpts
    return new Promise((resolve, reject) => {
      let settled = false
      const addedAt = persistOverride?.addedAt ?? Date.now()
      const isMagnet = typeof idForClient === 'string' && idForClient.startsWith('magnet:')

      const settleResolve = (torrent) => {
        if (settled) return
        settled = true
        resolve(summarize(torrent))
      }

      let torrent
      try {
        // `deselect: true` — see the module header comment: this prevents
        // webtorrent's normal "select the entire torrent" default from ever
        // running, so nothing downloads until `classifyAndSelect` (below,
        // on 'metadata') explicitly selects the audio files.
        torrent = client.add(idForClient, { path: downloadDir, paused, deselect: true }, (readyTorrent) => {
          settleResolve(readyTorrent)
        })
      } catch (err) {
        reject(err)
        return
      }

      // Pre-populate the trimmed safety summary from a restored entry (if
      // any) immediately, synchronously — so `summarize()` can show the
      // last-known badge right away instead of "checking…" while waiting
      // for 'metadata' to re-arrive. Real classification (below) always
      // overwrites this once it runs; this is a display-only convenience,
      // never the source of truth (docs/PLAN4.md).
      if (persistOverride?.safety) {
        safetyReports.set(torrent, {
          verdict: persistOverride.safety.verdict,
          hasAudio: persistOverride.safety.hasAudio,
          audio: [],
          // Only `.length` is ever read off this placeholder (via
          // `summarize()`'s `safety.skippedCount`) before real
          // classification overwrites the whole entry — a sparse array of
          // the right length is enough, no need for real entries.
          skipped: new Array(persistOverride.safety.skippedCount || 0)
        })
      }

      // Started unconditionally (not just once a torrent reaches 'ready') so
      // the very first added torrent is already visible via `torrents:list`
      // and gets picked up by the next `torrents:progress` broadcast, rather
      // than only appearing once its metadata/peers arrive. Safe to call
      // before any window exists (re-adding persisted torrents on startup
      // happens before `createWindow()`): `broadcastProgress()` no-ops
      // whenever `getWindow()` returns null/destroyed.
      ensureProgressLoop()

      // Normal case: infoHash is parsed (near-)synchronously for magnet URIs
      // and torrent files, well before 'ready' (which needs peers/metadata).
      torrent.once('infoHash', () => {
        recordPersistMeta(torrent, idForClient, isMagnet, addedAt, persistOverride).catch((err) => {
          console.error('[torrents] failed to record persistence metadata:', err)
        })
        settleResolve(torrent)
      })
      // Fires once the file list is known — for a magnet URI this arrives
      // later, from peers, well after 'infoHash'/`add()`'s own resolution;
      // for a .torrent file it's available (near-)immediately. Either way,
      // this is the single place classification + selective download
      // happens (see module header comment + `classifyAndSelect`).
      torrent.once('metadata', () => classifyAndSelect(torrent))
      // Duplicate case: webtorrent destroys `torrent` before its own public
      // 'infoHash' event fires — and because we've attached an 'error'
      // listener below, that destroy path synchronously *emits* an error on
      // `torrent` (message: "Cannot add duplicate torrent ...") *before*
      // calling the `ontorrent` callback above with the pre-existing
      // torrent. Don't let that internal control-flow signal reject the
      // promise; let it fall through to `ontorrent`'s `settleResolve`.
      torrent.once('error', (err) => {
        if (settled) return
        if (typeof err?.message === 'string' && err.message.startsWith('Cannot add duplicate torrent')) {
          return
        }
        reject(err)
      })
    })
  }

  /**
   * Add a torrent by magnet URI or path to a .torrent file.
   *
   * Resolves as soon as the torrent's infoHash is known (effectively
   * immediate for magnet URIs) rather than waiting for peers/metadata —
   * a magnet with no connectable peers may never reach 'ready', which would
   * otherwise hang this promise (and the renderer's `torrentsAdd` call)
   * forever.
   *
   * @returns {Promise<{infoHash:string, name:string, progress:number, downloadSpeed:number, numPeers:number, done:boolean, paused:boolean, safety:{verdict:string,hasAudio:boolean,skippedCount:number}|null}>}
   */
  function add(magnetOrTorrentPath, downloadDir) {
    return addInternal(magnetOrTorrentPath, downloadDir)
  }

  /**
   * Re-add all persisted, non-done torrents from a previous session. Meant
   * to be called once during app bootstrap, before a window exists. Failures
   * for individual entries are logged and skipped rather than thrown, so one
   * bad entry can't block the rest (or app startup).
   */
  async function restorePersisted() {
    const entries = await loadPersistedTorrents(torrentsFilePath).catch((err) => {
      console.error('[torrents] failed to read torrents.json:', err)
      return []
    })
    for (const entry of entries) {
      // Belt-and-braces: an already-imported torrent should never have been
      // written to torrents.json in the first place (persistNow excludes
      // it), but if a stale/hand-edited file somehow has one marked
      // `imported: true`, never re-add it outright rather than trusting
      // `persistNow`'s predicate to prune it again on the next write.
      if (entry?.imported) continue
      const idForClient = entry?.torrentFileCopyPath || entry?.magnetOrInfoHash
      if (!idForClient || !entry?.downloadDir) continue
      try {
        // A previously-paused torrent re-adds then immediately pauses again
        // (passed as the initial `paused` state rather than added-then-
        // paused, so it never briefly starts downloading on restart).
        await addInternal(idForClient, entry.downloadDir, { paused: !!entry.paused, persistOverride: entry })
      } catch (err) {
        console.error('[torrents] failed to re-add persisted torrent on startup:', entry.magnetOrInfoHash, err)
      }
    }
  }

  async function pause(infoHash) {
    const torrent = findTorrent(infoHash)
    if (!torrent) throw new Error(`Torrent not found: ${infoHash}`)
    // NOTE: webtorrent's `pause()` stops choosing new peers/pieces but does
    // not forcibly disconnect already-open connections or guarantee downloads
    // halt instantly. `torrent.paused` is tracked by webtorrent itself and is
    // what we surface to the renderer (and persist).
    torrent.pause()
    await persistNow()
    return summarize(torrent)
  }

  async function resume(infoHash) {
    const torrent = findTorrent(infoHash)
    if (!torrent) throw new Error(`Torrent not found: ${infoHash}`)
    torrent.resume()
    await persistNow()
    return summarize(torrent)
  }

  async function remove(infoHash, { deleteFiles = false } = {}) {
    const torrent = findTorrent(infoHash)
    if (torrent) {
      const meta = persistMeta.get(torrent)
      await client.remove(torrent, { destroyStore: !!deleteFiles })
      // Best-effort cleanup of the copied .torrent file (if this was a
      // file-based add) — removed torrents no longer need it, and leaving
      // it around would silently accumulate in userData/torrents/ forever.
      if (meta?.torrentFileCopyPath) {
        await fs.unlink(meta.torrentFileCopyPath).catch(() => {})
      }
    }
    await persistNow()
    // Broadcast immediately (rather than waiting up to 1s for the next
    // interval tick) so a removed torrent — including the last remaining
    // one, now an empty list — doesn't linger as a ghost row in the
    // renderer until the next scheduled tick.
    broadcastProgress()
    return { ok: true }
  }

  async function destroy() {
    if (progressTimer) clearInterval(progressTimer)
    // Final flush on quit, per docs/PLAN2.md, so in-progress downloads are
    // re-added (respecting paused state) on next launch.
    await persistNow().catch(() => {})
    return new Promise((resolve) => client.destroy(() => resolve()))
  }

  return {
    add,
    list,
    pause,
    resume,
    remove,
    destroy,
    restorePersisted,
    // Test-only, deliberately namespaced — never referenced by main.js.
    // Exists so the classify -> select -> cleanup -> completion flow
    // (docs/PLAN4.md/PLAN4B.md) can have automated coverage
    // (tests/torrents.completion.test.js) against a REAL webtorrent client
    // without needing actual peer-to-peer data transfer (audio completion
    // is simulated by directly marking a File object done and firing its
    // 'done' event, exactly matching real webtorrent's own `_checkDone()`
    // once a file's pieces verify — see that test file for why this is a
    // faithful simulation, not a shortcut around the real code path).
    __TEST_ONLY: { getClient: () => client, getSafetyReports: () => safetyReports }
  }
}
