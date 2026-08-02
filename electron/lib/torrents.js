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

import path from 'node:path'
import { promises as fs } from 'node:fs'
import WebTorrent from 'webtorrent'
import { scanBookFiles, isAudioFile } from './metadata.js'
import { loadPersistedTorrents, savePersistedTorrents } from './torrentPersistence.js'

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
 */
export function createTorrentManager({ library, coversDir, getWindow, torrentsFilePath, torrentFilesDir }) {
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
  // Guards against attaching a 'done' listener to the same torrent instance
  // more than once. webtorrent's own duplicate-add detection invokes our
  // `ontorrent` callback with the *pre-existing* torrent object whenever a
  // caller adds a magnet/torrent that's already active, so without this a
  // second `add()` for the same torrent would stack a second 'done' handler
  // and auto-import the same completed book twice.
  const doneHandlerAttached = new WeakSet()
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

  function summarize(torrent) {
    return {
      infoHash: torrent.infoHash,
      name: torrent.name,
      progress: torrent.progress,
      downloadSpeed: torrent.downloadSpeed,
      numPeers: torrent.numPeers,
      done: torrent.done,
      paused: !!torrent.paused
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

  function ensureDoneHandler(torrent) {
    if (doneHandlerAttached.has(torrent)) return
    doneHandlerAttached.add(torrent)
    torrent.on('done', () => handleDone(torrent))
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
      // in flight, `t.done` is already true but neither `meta.imported` nor
      // `findBook` is true yet. Excluding on `t.done` alone would flush a
      // torrents.json that has already forgotten this torrent, orphaning
      // its downloaded files with no retry on next launch. Keeping it
      // persisted instead means next startup re-adds it, webtorrent
      // re-verifies the already-complete data on disk, 'done' fires again,
      // and `handleDone` (already idempotent via its own findBook check)
      // imports it — self-healing rather than silently losing the book.
      .filter((t) => {
        const meta = persistMeta.get(t)
        const imported = !!meta?.imported || !!library.findBook(`b${t.infoHash.slice(0, 16)}`)
        return !(t.done && imported)
      })
      .map((t) => {
        const meta = persistMeta.get(t)
        return {
          magnetOrInfoHash: meta?.magnetOrInfoHash ?? t.infoHash,
          torrentFileCopyPath: meta?.torrentFileCopyPath ?? null,
          downloadDir: meta?.downloadDir ?? t.path,
          paused: !!t.paused,
          addedAt: meta?.addedAt ?? Date.now(),
          imported: !!meta?.imported
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
      const coverCandidates = torrent.files
        .filter((f) => !isAudioFile(f.name))
        .map((f) => path.join(torrent.path, f.path))

      const bookId = `b${torrent.infoHash.slice(0, 16)}`
      // Guards against re-importing the same torrent's book a second time —
      // e.g. if a user re-adds a magnet that already finished downloading in
      // a previous session, or 'done' otherwise fires more than once for the
      // same torrent (defense in depth alongside `ensureDoneHandler`).
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
        torrent = client.add(idForClient, { path: downloadDir, paused }, (readyTorrent) => {
          ensureDoneHandler(readyTorrent)
          settleResolve(readyTorrent)
        })
      } catch (err) {
        reject(err)
        return
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
   * @returns {Promise<{infoHash:string, name:string, progress:number, downloadSpeed:number, numPeers:number, done:boolean, paused:boolean}>}
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

  return { add, list, pause, resume, remove, destroy, restorePersisted }
}
