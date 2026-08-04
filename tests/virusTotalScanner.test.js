import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { createLibraryStore } from '../electron/lib/library.js'
import { createVirusTotalScanner } from '../electron/lib/virusTotalScanner.js'
import { hashFile } from '../electron/lib/virusTotal.js'
import { DEFAULT_REQUEST_INTERVAL_MS } from '../electron/lib/scanQueue.js'

// --- Manual clock (same technique as tests/scanQueue.test.js) — lets tests
// that DO need to exercise the live rate-limited queue (as opposed to a
// cache hit, which never touches it) drive multi-request scheduling
// deterministically instead of waiting on real 15s gaps. ---
function createManualClock(startAt = 0) {
  let now = startAt
  let nextId = 1
  const timers = new Map()
  return {
    clock: {
      now: () => now,
      setTimeout: (fn, ms) => {
        const id = nextId++
        timers.set(id, { deadline: now + Math.max(0, ms), fn })
        return id
      },
      clearTimeout: (id) => timers.delete(id)
    },
    async advance(ms) {
      const targetTime = now + ms
      while (true) {
        const entries = [...timers.entries()]
        if (!entries.length) {
          now = targetTime
          return
        }
        const [nextIdKey, nextTimer] = entries.reduce((a, b) => (a[1].deadline <= b[1].deadline ? a : b))
        if (nextTimer.deadline > targetTime) {
          now = targetTime
          return
        }
        now = nextTimer.deadline
        timers.delete(nextIdKey)
        await nextTimer.fn()
      }
    }
  }
}

/** Repeatedly yields to the real event loop (for genuine fs/promise I/O to
 * progress) and advances the fake clock (for the queue's rate-limit timer),
 * until `conditionFn()` is true or we give up.
 *
 * Yields via a real (if tiny) `setTimeout`, not a zero-cost `setImmediate`.
 * A zero-cost yield lets the loop burn through its whole retry budget in a
 * handful of real milliseconds — fine when the system is idle, but under
 * full-suite load (many test files doing real disk I/O concurrently) the
 * underlying async work this waits on (hashing, cache persistence, the
 * library's atomic tmp-file+rename save) can genuinely take longer than
 * that to settle, so the loop would give up before the condition ever had a
 * real chance to become true — not because anything is broken, but because
 * "300 iterations" isn't a real time budget when each iteration is free.
 * A small per-iteration timer makes the retry budget correspond to actual
 * elapsed wall-clock time instead. This still returns the instant the
 * condition is true; it never blocks longer than necessary. */
async function runUntil(conditionFn, { advance, maxRounds = 300, stepMs = 5 } = {}) {
  for (let i = 0; i < maxRounds; i++) {
    if (conditionFn()) return
    await new Promise((resolve) => setTimeout(resolve, stepMs))
    if (advance) await advance(DEFAULT_REQUEST_INTERVAL_MS)
  }
  throw new Error('runUntil: condition never became true')
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { get: () => null }
  }
}

function knownStatsResponse(malicious, suspicious) {
  return jsonResponse(200, {
    data: { attributes: { last_analysis_stats: { malicious, suspicious, harmless: 60, undetected: 5 } } }
  })
}

let root
let library
let sentEvents

async function makeFile(name, content) {
  const filePath = path.join(root, name)
  await fs.writeFile(filePath, content)
  return filePath
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vt-scanner-'))
  library = createLibraryStore(path.join(root, 'library.json'))
  await library.load()
  sentEvents = []
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function fakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sentEvents.push({ channel, payload }) }
  }
}

function makeScanner(overrides = {}) {
  const settings = { virusTotalEnabled: true, virusTotalApiKey: 'test-key', ...overrides.settings }
  return {
    settings,
    scanner: createVirusTotalScanner({
      library,
      getWindow: () => fakeWindow(),
      getSettings: () => settings,
      cacheFilePath: overrides.cacheFilePath,
      fetchImpl: overrides.fetchImpl,
      clock: overrides.clock
    })
  }
}

describe('createVirusTotalScanner — cache replay must never change a verdict\'s meaning (BLOCKING fix)', () => {
  it('a cached "unknown" hash re-reads as unknown and the book verdict is unknown, NEVER clean', async () => {
    const filePath = await makeFile('01.mp3', 'unknown-file-content')
    const sha256 = await hashFile(filePath)
    const book = await library.addBook({ title: 'T', author: 'A', files: [filePath] })

    let fetchCalls = 0
    const { scanner } = makeScanner({
      cacheFilePath: path.join(root, 'vt-cache.json'),
      fetchImpl: async () => {
        fetchCalls += 1
        return jsonResponse(404, {})
      }
    })

    // First scan: genuinely unknown (404), gets cached.
    await scanner.scanBook(book.id)
    await runUntil(() => sentEvents.some((e) => e.channel === 'virusTotal:scan-complete'))
    const firstComplete = sentEvents.find((e) => e.channel === 'virusTotal:scan-complete')
    expect(firstComplete.payload.verdict).toBe('unknown')
    expect(fetchCalls).toBe(1)

    // Second scan (e.g. a manual re-scan within the 30-day TTL): must be a
    // cache HIT — no new network call — and must STILL read as unknown,
    // never flip to "clean" just because malicious/suspicious are both 0.
    sentEvents.length = 0
    await scanner.scanBook(book.id)
    await runUntil(() => sentEvents.some((e) => e.channel === 'virusTotal:scan-complete'))
    const secondComplete = sentEvents.find((e) => e.channel === 'virusTotal:scan-complete')
    expect(secondComplete.payload.verdict).toBe('unknown')
    expect(fetchCalls).toBe(1) // still 1 — served from cache, no re-lookup

    const finalBook = library.findBook(book.id)
    expect(finalBook.scan.verdict).toBe('unknown')
    expect(finalBook.scan.files[0].verdict).toBe('unknown')
  })

  it('cached infected round-trips as infected on replay', async () => {
    const filePath = await makeFile('01.mp3', 'infected-file')
    const sha256 = await hashFile(filePath)
    const book = await library.addBook({ title: 'T', author: 'A', files: [filePath] })
    const cacheFilePath = path.join(root, 'vt-cache.json')
    await fs.writeFile(
      cacheFilePath,
      JSON.stringify({ [sha256]: { verdict: 'infected', malicious: 3, suspicious: 0, checkedAt: Date.now() } })
    )

    let fetchCalls = 0
    const { scanner } = makeScanner({ cacheFilePath, fetchImpl: async () => { fetchCalls += 1; return jsonResponse(500, {}) } })

    await scanner.scanBook(book.id)
    await runUntil(() => sentEvents.some((e) => e.channel === 'virusTotal:scan-complete'))
    const complete = sentEvents.find((e) => e.channel === 'virusTotal:scan-complete')
    expect(complete.payload.verdict).toBe('infected')
    expect(fetchCalls).toBe(0) // never touched the network — pure cache hit
  })

  it('cached suspicious round-trips as suspicious on replay', async () => {
    const filePath = await makeFile('01.mp3', 'suspicious-file')
    const sha256 = await hashFile(filePath)
    const book = await library.addBook({ title: 'T', author: 'A', files: [filePath] })
    const cacheFilePath = path.join(root, 'vt-cache.json')
    await fs.writeFile(
      cacheFilePath,
      JSON.stringify({ [sha256]: { verdict: 'suspicious', malicious: 0, suspicious: 4, checkedAt: Date.now() } })
    )
    const { scanner } = makeScanner({ cacheFilePath, fetchImpl: async () => jsonResponse(500, {}) })

    await scanner.scanBook(book.id)
    await runUntil(() => sentEvents.some((e) => e.channel === 'virusTotal:scan-complete'))
    expect(sentEvents.find((e) => e.channel === 'virusTotal:scan-complete').payload.verdict).toBe('suspicious')
  })

  it('cached clean round-trips as clean on replay', async () => {
    const filePath = await makeFile('01.mp3', 'clean-file')
    const sha256 = await hashFile(filePath)
    const book = await library.addBook({ title: 'T', author: 'A', files: [filePath] })
    const cacheFilePath = path.join(root, 'vt-cache.json')
    await fs.writeFile(
      cacheFilePath,
      JSON.stringify({ [sha256]: { verdict: 'clean', malicious: 0, suspicious: 0, checkedAt: Date.now() } })
    )
    const { scanner } = makeScanner({ cacheFilePath, fetchImpl: async () => jsonResponse(500, {}) })

    await scanner.scanBook(book.id)
    await runUntil(() => sentEvents.some((e) => e.channel === 'virusTotal:scan-complete'))
    expect(sentEvents.find((e) => e.channel === 'virusTotal:scan-complete').payload.verdict).toBe('clean')
  })

  it('a fresh (non-cached) 404 is itself reported as unknown, then correctly cached so a later hit stays unknown', async () => {
    const filePath = await makeFile('01.mp3', 'never-seen-by-vt')
    const book = await library.addBook({ title: 'T', author: 'A', files: [filePath] })
    const cacheFilePath = path.join(root, 'vt-cache.json')
    const { scanner } = makeScanner({ cacheFilePath, fetchImpl: async () => jsonResponse(404, {}) })

    await scanner.scanBook(book.id)
    await runUntil(() => sentEvents.some((e) => e.channel === 'virusTotal:scan-complete'))
    expect(sentEvents.find((e) => e.channel === 'virusTotal:scan-complete').payload.verdict).toBe('unknown')

    const cacheOnDisk = JSON.parse(await fs.readFile(cacheFilePath, 'utf-8'))
    const sha256 = await hashFile(filePath)
    expect(cacheOnDisk[sha256].verdict).toBe('unknown')
    expect(cacheOnDisk[sha256].malicious).toBe(0)
    expect(cacheOnDisk[sha256].suspicious).toBe(0)
  })
})

describe('createVirusTotalScanner — duplicate hashes within one book', () => {
  it('two files with identical content (same hash) never diverge and only cost ONE live lookup', async () => {
    const fileA = await makeFile('01.mp3', 'shared-content-both-files')
    const fileB = await makeFile('02.mp3', 'shared-content-both-files') // identical content -> identical hash
    const fileC = await makeFile('03.mp3', 'unique-content-for-file-c')
    const book = await library.addBook({ title: 'T', author: 'A', files: [fileA, fileB, fileC] })

    const shaAB = await hashFile(fileA)
    const shaC = await hashFile(fileC)
    const callsPerHash = new Map()
    const { clock, advance } = createManualClock()
    const { scanner } = makeScanner({
      clock,
      fetchImpl: async (url) => {
        const hash = url.split('/').pop()
        callsPerHash.set(hash, (callsPerHash.get(hash) ?? 0) + 1)
        if (hash === shaAB) return knownStatsResponse(2, 0) // infected
        if (hash === shaC) return knownStatsResponse(0, 0) // clean
        throw new Error(`unexpected hash requested: ${hash}`)
      }
    })

    await scanner.scanBook(book.id)
    await runUntil(() => sentEvents.some((e) => e.channel === 'virusTotal:scan-complete'), { advance })

    expect(callsPerHash.get(shaAB)).toBe(1) // deduped: ONE network call covers both fileA and fileB
    expect(callsPerHash.get(shaC)).toBe(1)

    const finalBook = library.findBook(book.id)
    const [rA, rB, rC] = finalBook.scan.files
    expect(rA.verdict).toBe('infected')
    expect(rB.verdict).toBe('infected') // same hash as A -> must not diverge
    expect(rA.sha256).toBe(rB.sha256)
    expect(rC.verdict).toBe('clean')
    expect(finalBook.scan.verdict).toBe('infected') // book-level: worst file wins
  })
})

describe('createVirusTotalScanner — book-level verdict aggregation', () => {
  async function seedCachedFile(name, content, verdict, malicious, suspicious, cacheFilePath) {
    const filePath = await makeFile(name, content)
    const sha256 = await hashFile(filePath)
    let existing = {}
    try {
      existing = JSON.parse(await fs.readFile(cacheFilePath, 'utf-8'))
    } catch {
      // first entry
    }
    existing[sha256] = { verdict, malicious, suspicious, checkedAt: Date.now() }
    await fs.writeFile(cacheFilePath, JSON.stringify(existing))
    return filePath
  }

  it('infected beats suspicious beats clean when files disagree', async () => {
    const cacheFilePath = path.join(root, 'vt-cache.json')
    const f1 = await seedCachedFile('01.mp3', 'a', 'clean', 0, 0, cacheFilePath)
    const f2 = await seedCachedFile('02.mp3', 'b', 'suspicious', 0, 3, cacheFilePath)
    const f3 = await seedCachedFile('03.mp3', 'c', 'infected', 1, 0, cacheFilePath)
    const book = await library.addBook({ title: 'T', author: 'A', files: [f1, f2, f3] })

    const { scanner } = makeScanner({ cacheFilePath, fetchImpl: async () => jsonResponse(500, {}) })
    await scanner.scanBook(book.id)
    await runUntil(() => sentEvents.some((e) => e.channel === 'virusTotal:scan-complete'))

    expect(library.findBook(book.id).scan.verdict).toBe('infected')
  })

  it('suspicious beats clean when no file is infected', async () => {
    const cacheFilePath = path.join(root, 'vt-cache.json')
    const f1 = await seedCachedFile('01.mp3', 'a', 'clean', 0, 0, cacheFilePath)
    const f2 = await seedCachedFile('02.mp3', 'b', 'suspicious', 0, 3, cacheFilePath)
    const book = await library.addBook({ title: 'T', author: 'A', files: [f1, f2] })

    const { scanner } = makeScanner({ cacheFilePath, fetchImpl: async () => jsonResponse(500, {}) })
    await scanner.scanBook(book.id)
    await runUntil(() => sentEvents.some((e) => e.channel === 'virusTotal:scan-complete'))

    expect(library.findBook(book.id).scan.verdict).toBe('suspicious')
  })

  it('all-clean files -> book verdict clean', async () => {
    const cacheFilePath = path.join(root, 'vt-cache.json')
    const f1 = await seedCachedFile('01.mp3', 'a', 'clean', 0, 0, cacheFilePath)
    const f2 = await seedCachedFile('02.mp3', 'b', 'clean', 0, 0, cacheFilePath)
    const book = await library.addBook({ title: 'T', author: 'A', files: [f1, f2] })

    const { scanner } = makeScanner({ cacheFilePath, fetchImpl: async () => jsonResponse(500, {}) })
    await scanner.scanBook(book.id)
    await runUntil(() => sentEvents.some((e) => e.channel === 'virusTotal:scan-complete'))

    expect(library.findBook(book.id).scan.verdict).toBe('clean')
  })

  it('a mix of clean and unknown (none infected/suspicious) -> book verdict unknown, not clean', async () => {
    const cacheFilePath = path.join(root, 'vt-cache.json')
    const f1 = await seedCachedFile('01.mp3', 'a', 'clean', 0, 0, cacheFilePath)
    const f2 = await seedCachedFile('02.mp3', 'b', 'unknown', 0, 0, cacheFilePath)
    const book = await library.addBook({ title: 'T', author: 'A', files: [f1, f2] })

    const { scanner } = makeScanner({ cacheFilePath, fetchImpl: async () => jsonResponse(500, {}) })
    await scanner.scanBook(book.id)
    await runUntil(() => sentEvents.some((e) => e.channel === 'virusTotal:scan-complete'))

    expect(library.findBook(book.id).scan.verdict).toBe('unknown')
  })
})

describe('createVirusTotalScanner — gating and misc', () => {
  it('scanBook is a no-op when VirusTotal is not enabled', async () => {
    const filePath = await makeFile('01.mp3', 'x')
    const book = await library.addBook({ title: 'T', author: 'A', files: [filePath] })
    const { scanner } = makeScanner({ settings: { virusTotalEnabled: false, virusTotalApiKey: null } })
    const result = await scanner.scanBook(book.id)
    expect(result).toEqual({ queued: false })
    expect(library.findBook(book.id).scan).toBeNull()
  })

  it('scanBook is a no-op for a nonexistent book', async () => {
    const { scanner } = makeScanner()
    const result = await scanner.scanBook('does-not-exist')
    expect(result).toEqual({ queued: false })
  })

  it('an auth-error aborts the whole scan: book state is "error", verdict null, no scan-complete broadcast', async () => {
    const filePath = await makeFile('01.mp3', 'x')
    const book = await library.addBook({ title: 'T', author: 'A', files: [filePath] })
    const { scanner } = makeScanner({ fetchImpl: async () => jsonResponse(401, {}) })

    await scanner.scanBook(book.id)
    // NOTE: the very first `library:changed` broadcast happens at the START
    // of the scan (state: 'scanning'), before the auth-error is even
    // detected — waiting for that event alone would race. The auth-error
    // path fires `library:changed` exactly twice: once at scan-start, and
    // once after `library.setBookScan(...)` — including its internal async
    // `save()` disk write — has fully resolved (virusTotalScanner.js: the
    // `broadcastLibraryChanged()` right after the `authFailed` block's
    // `await library.setBookScan(...)`). Waiting for in-memory
    // `book.scan.state` instead is unsafe: `setBookScan` mutates that field
    // synchronously *before* awaiting its disk write, so polling it can
    // observe "error" before the save has actually finished — letting this
    // test return and race `afterEach`'s directory removal against a
    // still-in-flight write (observed as an intermittent ENOTEMPTY). Wait
    // for the second broadcast instead: it's only ever sent after the save
    // has genuinely settled.
    await runUntil(() => sentEvents.filter((e) => e.channel === 'library:changed').length >= 2)

    const finalBook = library.findBook(book.id)
    expect(finalBook.scan.state).toBe('error')
    expect(finalBook.scan.verdict).toBeNull()
    expect(sentEvents.some((e) => e.channel === 'virusTotal:scan-complete')).toBe(false)
  })

  it('a transient (non-auth) network error persists state "error" (not "done"), so it gets re-queued on next startup', async () => {
    const filePath = await makeFile('01.mp3', 'x')
    const book = await library.addBook({ title: 'T', author: 'A', files: [filePath] })
    const { scanner } = makeScanner({
      fetchImpl: async () => {
        throw new Error('ECONNRESET')
      }
    })

    await scanner.scanBook(book.id)
    await runUntil(() => sentEvents.some((e) => e.channel === 'virusTotal:scan-complete'))

    const finalBook = library.findBook(book.id)
    // The scan still "completes" (best-effort result surfaced to the user)...
    expect(finalBook.scan.state).toBe('error')
    // ...but is NOT silently treated as a fresh, trustworthy 30-day result.
    expect(sentEvents.find((e) => e.channel === 'virusTotal:scan-complete')).toBeTruthy()
  })

  it('a book removed mid-scan is never the subject of a scan-complete broadcast (no ghost entries)', async () => {
    const filePath = await makeFile('01.mp3', 'x')
    const book = await library.addBook({ title: 'T', author: 'A', files: [filePath] })

    let releaseFetch = null
    const fetchImpl = () =>
      new Promise((resolve) => {
        releaseFetch = () => resolve(jsonResponse(404, {}))
      })
    const { scanner } = makeScanner({ fetchImpl })

    await scanner.scanBook(book.id)
    await runUntil(() => typeof releaseFetch === 'function')

    // Book is removed from the library WHILE the lookup is still in flight.
    await library.removeBook(book.id, { deleteFiles: false })
    releaseFetch()

    // Give the scan's continuation a chance to run to completion.
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))

    expect(sentEvents.some((e) => e.channel === 'virusTotal:scan-complete')).toBe(false)
    expect(library.findBook(book.id)).toBeNull()
  })
})

describe('createVirusTotalScanner — enqueueStaleBooks', () => {
  it('re-queues books with no scan field, state "error", state "scanning", and a stale "done" scan', async () => {
    const f1 = await makeFile('01.mp3', 'a')
    const f2 = await makeFile('02.mp3', 'b')
    const f3 = await makeFile('03.mp3', 'c')
    const f4 = await makeFile('04.mp3', 'd')

    const noScanBook = await library.addBook({ title: 'NoScan', author: 'A', files: [f1] })
    const errorBook = await library.addBook({ title: 'ErrorScan', author: 'A', files: [f2] })
    await library.setBookScan(errorBook.id, { state: 'error', verdict: null, scannedAt: Date.now(), files: [] })
    const scanningBook = await library.addBook({ title: 'InterruptedScan', author: 'A', files: [f3] })
    await library.setBookScan(scanningBook.id, { state: 'scanning', verdict: null, scannedAt: null, files: [] })
    const staleDoneBook = await library.addBook({ title: 'StaleDone', author: 'A', files: [f4] })
    await library.setBookScan(staleDoneBook.id, {
      state: 'done',
      verdict: 'clean',
      scannedAt: Date.now() - 31 * 24 * 60 * 60 * 1000, // 31 days ago — past the 30-day TTL
      files: []
    })

    // Four books here means four DISTINCT (uncached) live lookups, processed
    // one book at a time — the 2nd/3rd/4th each wait out the real rate
    // limit (DEFAULT_REQUEST_INTERVAL_MS) before dispatching. Needs the
    // injectable manual clock; real timers would make this test take ~45s.
    const scanned = new Set()
    const { clock, advance } = createManualClock()
    const { scanner } = makeScanner({
      clock,
      fetchImpl: async (url) => {
        scanned.add(url)
        return jsonResponse(404, {})
      }
    })

    scanner.enqueueStaleBooks()
    await runUntil(
      () =>
        [noScanBook, errorBook, scanningBook, staleDoneBook].every(
          (b) => sentEvents.filter((e) => e.channel === 'virusTotal:scan-complete' && e.payload.bookId === b.id).length > 0
        ),
      { advance, maxRounds: 1000 }
    )

    for (const b of [noScanBook, errorBook, scanningBook, staleDoneBook]) {
      expect(library.findBook(b.id).scan.state).toBe('done')
    }
  })

  it('does NOT re-queue a fresh "done" scan (within the 30-day TTL)', async () => {
    const f1 = await makeFile('01.mp3', 'a')
    const freshBook = await library.addBook({ title: 'Fresh', author: 'A', files: [f1] })
    await library.setBookScan(freshBook.id, { state: 'done', verdict: 'clean', scannedAt: Date.now(), files: [] })

    let fetchCalls = 0
    const { scanner } = makeScanner({
      fetchImpl: async () => {
        fetchCalls += 1
        return jsonResponse(404, {})
      }
    })

    scanner.enqueueStaleBooks()
    // Nothing to wait for asynchronously since it should never even enqueue
    // — give it a few event-loop turns to prove that, rather than a
    // positive wait condition.
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))

    expect(fetchCalls).toBe(0)
  })

  it('is a no-op entirely when VirusTotal is not enabled', async () => {
    const f1 = await makeFile('01.mp3', 'a')
    await library.addBook({ title: 'NoScan', author: 'A', files: [f1] })
    let fetchCalls = 0
    const { scanner } = makeScanner({
      settings: { virusTotalEnabled: false, virusTotalApiKey: null },
      fetchImpl: async () => {
        fetchCalls += 1
        return jsonResponse(404, {})
      }
    })
    scanner.enqueueStaleBooks()
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
    expect(fetchCalls).toBe(0)
  })
})
