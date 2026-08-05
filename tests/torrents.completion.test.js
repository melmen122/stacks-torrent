// tests/torrents.completion.test.js
//
// Automated coverage for electron/lib/torrents.js's classify -> select ->
// cleanup -> completion flow (docs/PLAN4.md/PLAN4B.md), previously verified
// only by hand (temporary test-only accessors added and reverted during
// development — see the backend agent's prior session reports). Uses a
// REAL (unmocked) webtorrent client via `createTorrentManager`'s permanent
// `__TEST_ONLY` export — no network/peers needed, since we're testing
// SELECTION/CLEANUP mechanics, not actual data transfer.
//
// Audio completion is simulated by directly marking a webtorrent `File`
// object `.done = true` and firing its `'done'` event. This is a faithful
// simulation, not a shortcut: real webtorrent's own `_checkDone()` (see
// node_modules/webtorrent/lib/torrent.js) does exactly this — sets
// `file.done = true` then `file.emit('done')` — once every piece in that
// file's range verifies against the local chunk store. Our tests just
// trigger that same signal directly instead of needing a real peer to
// supply real piece bytes over the network (which this sandbox cannot
// reliably do even for the simplest possible local loopback case — see
// prior session's extensive investigation).
//
// NOTE: relies on `create-torrent`, a transitive dependency of `webtorrent`
// (not a direct devDependency) — matches how this exact mechanism was
// manually verified during development. If it's ever removed from
// webtorrent's own dependency tree, add it as a direct devDependency.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import createTorrent from 'create-torrent'
import { createTorrentManager } from '../electron/lib/torrents.js'
import { NO_PEERS_TIMEOUT_MS } from '../electron/lib/discoveryState.js'

let root

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'torrents-completion-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function makeStubLibrary() {
  const books = new Map()
  return {
    findBook: (id) => books.get(id) ?? null,
    addBook: async (b) => {
      const book = { ...b }
      books.set(book.id, book)
      return book
    },
    _books: books
  }
}

async function buildTorrentFixture(name, files, pieceLength = 16384) {
  const contentDir = path.join(root, `${name}-content`)
  await fs.mkdir(contentDir, { recursive: true })
  for (const [fileName, content] of Object.entries(files)) {
    await fs.writeFile(path.join(contentDir, fileName), content)
  }
  const torrentBuf = await new Promise((resolve, reject) => {
    createTorrent(contentDir, { name, announce: [], pieceLength }, (err, buf) => {
      if (err) reject(err)
      else resolve(buf)
    })
  })
  const torrentPath = path.join(root, `${name}.torrent`)
  await fs.writeFile(torrentPath, torrentBuf)
  return { contentDir, torrentPath }
}

/** Waits for `torrent.files` to be populated (i.e. classification's
 * 'metadata' handler has run) by polling — classification is synchronous
 * for a .torrent-file add, but happens via a real event emission, so a
 * microtask/macrotask turn is needed.
 *
 * Yields via a real (if tiny) `setTimeout`, not a zero-cost `setImmediate`.
 * This uses a real webtorrent client doing real disk I/O; under full-suite
 * load a zero-cost spin can burn through its whole retry budget in a few
 * real milliseconds, giving genuinely-slower-under-contention I/O no actual
 * wall-clock time to complete. A small per-iteration timer makes the retry
 * budget correspond to real elapsed time instead, without ever waiting
 * longer than necessary — it still returns the instant the condition holds. */
async function waitFor(conditionFn, { maxRounds = 200, stepMs = 5 } = {}) {
  for (let i = 0; i < maxRounds; i++) {
    if (conditionFn()) return
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  throw new Error('waitFor: condition never became true')
}

describe('torrents.js completion/cleanup flow (real webtorrent client, no network)', () => {
  it('fresh add: classifies, selects only audio, imports on simulated completion, and cleans up a simulated boundary-piece spill (preserving a selected cover)', async () => {
    // Sized so audio and the executable land in genuinely different, mostly
    // non-overlapping piece ranges (see prior session's real verification
    // of this exact fixture shape) — proves cleanup targets the right file.
    const { contentDir, torrentPath } = await buildTorrentFixture('Fresh Book', {
      '01.mp3': 'x'.repeat(300000),
      'setup.exe': 'y'.repeat(200000),
      'cover.jpg': 'z'.repeat(1000)
    })

    const library = makeStubLibrary()
    const manager = createTorrentManager({
      library,
      coversDir: path.join(root, 'covers'),
      getWindow: () => null,
      torrentsFilePath: path.join(root, 'torrents.json'),
      torrentFilesDir: path.join(root, 'torrentfiles')
    })

    const summary = await manager.add(torrentPath, path.join(root, 'downloads'))
    const client = manager.__TEST_ONLY.getClient()
    const torrent = client.torrents.find((t) => t.infoHash === summary.infoHash)

    await waitFor(() => manager.__TEST_ONLY.getSafetyReports().has(torrent))
    const report = manager.__TEST_ONLY.getSafetyReports().get(torrent)
    expect(report.hasAudio).toBe(true)
    expect(report.verdict).toBe('danger')

    const downloadDir = path.join(root, 'downloads', 'Fresh Book')
    await fs.mkdir(downloadDir, { recursive: true })
    // Simulate the boundary-piece spill this cleanup exists to close.
    await fs.writeFile(path.join(downloadDir, 'setup.exe'), 'leaked-boundary-bytes')
    // Simulate the cover having been legitimately selected/downloaded.
    await fs.writeFile(path.join(downloadDir, 'cover.jpg'), 'z'.repeat(1000))

    const audioFile = torrent.files.find((f) => f.name === '01.mp3')
    audioFile.done = true
    audioFile.emit('done')

    await waitFor(() => library._books.size > 0)
    // Cleanup is fire-and-forget alongside handleDone — give it a moment.
    await waitFor(async () => !(await fs.access(path.join(downloadDir, 'setup.exe')).then(() => true, () => false)))

    const exeExists = await fs.access(path.join(downloadDir, 'setup.exe')).then(() => true, () => false)
    const coverExists = await fs.access(path.join(downloadDir, 'cover.jpg')).then(() => true, () => false)
    expect(exeExists).toBe(false) // cleaned up
    expect(coverExists).toBe(true) // never touched

    const [book] = [...library._books.values()]
    expect(book.title).toBeTruthy()
    expect(book.files.some((f) => f.endsWith('01.mp3'))).toBe(true)
    expect(book.files.some((f) => f.endsWith('setup.exe'))).toBe(false)

    await manager.destroy()
  })

  it('restore of already-complete local data: audio is recognized as immediately done (no waiting for a "done" event) and still imports + cleans up', async () => {
    // Piece-length-ALIGNED file sizes here, deliberately: real webtorrent
    // verification checks a whole piece's hash at once, and a piece can
    // span the boundary between two files (see the "fresh add" test above,
    // and torrents.js's own `cleanupSkippedFiles` doc comment) — if this
    // fixture's audio file's last piece were shared with setup.exe, that
    // piece could never verify without setup.exe's real bytes ALSO being
    // on disk (which we deliberately don't place, since we're testing that
    // audio-only content already being present is enough). Sizing both
    // files as exact multiples of pieceLength keeps them on independent,
    // non-overlapping piece ranges, so this test isolates exactly the
    // "already downloaded" detection path, not the boundary-piece mechanic
    // (already covered by the "fresh add" test above).
    const pieceLength = 16384
    const { contentDir, torrentPath } = await buildTorrentFixture('Restored Book', {
      '01.mp3': 'a'.repeat(pieceLength * 10),
      'setup.exe': 'b'.repeat(pieceLength * 5)
    }, pieceLength)

    // Pre-place the audio content at the exact path a restored torrent
    // would look for it, so webtorrent's own verification (which runs
    // regardless of selection) marks those pieces already-downloaded.
    const downloadDir = path.join(root, 'restored-downloads')
    const bookDir = path.join(downloadDir, 'Restored Book')
    await fs.mkdir(bookDir, { recursive: true })
    await fs.copyFile(path.join(contentDir, '01.mp3'), path.join(bookDir, '01.mp3'))

    const library = makeStubLibrary()
    const manager = createTorrentManager({
      library,
      coversDir: path.join(root, 'covers2'),
      getWindow: () => null,
      torrentsFilePath: path.join(root, 'torrents2.json'),
      torrentFilesDir: path.join(root, 'torrentfiles2')
    })

    await manager.add(torrentPath, downloadDir)

    // The audio file was already fully present+verified on disk before any
    // 'done' event could fire — attachAudioCompletionTracking's own
    // `remaining <= 0` fallback (not a live event) is what must catch this.
    await waitFor(() => library._books.size > 0, { maxRounds: 400 })

    const exeExists = await fs.access(path.join(bookDir, 'setup.exe')).then(() => true, () => false)
    expect(exeExists).toBe(false) // never selected, never leaked here either

    const [book] = [...library._books.values()]
    expect(book.files.some((f) => f.endsWith('01.mp3'))).toBe(true)

    await manager.destroy()
  })

  // Review fix (MAJOR): resume() must reset discovery timing so a
  // long-paused/restored torrent doesn't immediately read as 'no-peers' the
  // instant it's resumed, before the client has had any chance to
  // reconnect. Pure discoveryState.js tests can't reach this — the bug is
  // specifically that `resume()` in torrents.js failed to reset the
  // per-torrent timing state it owns — so this exercises the real thing.
  it('resume() of a restored, long-paused torrent grants a fresh discovery grace window (no immediate "no-peers")', async () => {
    const { torrentPath } = await buildTorrentFixture('Resume Book', {
      '01.mp3': 'x'.repeat(50000)
    })

    const library = makeStubLibrary()
    const torrentsFilePath = path.join(root, 'torrents-resume.json')
    const downloadDir = path.join(root, 'resume-downloads')
    // Simulate a persisted entry from a long-ago session: added well past
    // the no-peers grace period, and left paused.
    const oldAddedAt = Date.now() - NO_PEERS_TIMEOUT_MS * 10
    await fs.mkdir(path.dirname(torrentsFilePath), { recursive: true })
    await fs.writeFile(
      torrentsFilePath,
      JSON.stringify([
        {
          magnetOrInfoHash: torrentPath,
          torrentFileCopyPath: torrentPath,
          downloadDir,
          addedAt: oldAddedAt,
          paused: true,
          imported: false
        }
      ])
    )

    const manager = createTorrentManager({
      library,
      coversDir: path.join(root, 'resume-covers'),
      getWindow: () => null,
      torrentsFilePath,
      torrentFilesDir: path.join(root, 'resume-torrentfiles')
    })

    await manager.restorePersisted()
    const [restored] = manager.list()
    expect(restored.paused).toBe(true)
    // Confirms the fixture actually exercises the old-addedAt path: while
    // still paused, the paused exemption masks it, but discovery must NOT
    // yet be 'connected' via any grace-period reset — i.e. this restored
    // entry really did carry the old addedAt through to `discoveryTiming`.
    expect(['searching', 'connected']).toContain(restored.discovery)

    const resumed = await manager.resume(restored.infoHash)
    // The real bug: without the fix, this reads 'no-peers' immediately
    // because `resume()` never reset the old `addedAt`/`lastPeerSeenAt`.
    expect(resumed.discovery).not.toBe('no-peers')

    const [afterResume] = manager.list()
    expect(afterResume.discovery).not.toBe('no-peers')

    await manager.destroy()
  })
})
