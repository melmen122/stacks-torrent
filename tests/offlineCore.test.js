import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CHUNK_SIZE,
  planChunks,
  findMissingChunks,
  chunkKey,
  sumFileByteLengths,
  formatBytes,
  finalizeDownloadOutcome,
  validateChunkResponse,
  deriveDownloadState,
  positionQueueKey,
  collapsePositionQueue,
  resolveLatestQueuedPosition,
  queueIdsForKey,
  isPermanentQueueFailure,
  nextQueueAction,
  filesToWarm,
  findOrphanDownloads
} from '../mobile/offline-core.js'

describe('planChunks', () => {
  it('returns no chunks for a zero-byte file', () => {
    expect(planChunks(0)).toEqual([])
  })

  it('returns no chunks for negative or non-finite lengths', () => {
    expect(planChunks(-1)).toEqual([])
    expect(planChunks(NaN)).toEqual([])
    expect(planChunks(Infinity)).toEqual([])
  })

  it('produces one chunk for a file smaller than the chunk size', () => {
    const chunks = planChunks(5, 8)
    expect(chunks).toEqual([{ index: 0, start: 0, end: 4 }])
  })

  it('splits an exact multiple of the chunk size with no trailing empty chunk', () => {
    const chunks = planChunks(16, 8)
    expect(chunks).toEqual([
      { index: 0, start: 0, end: 7 },
      { index: 1, start: 8, end: 15 }
    ])
  })

  it('gives the final chunk a correct inclusive end when the file size is not a multiple', () => {
    const chunks = planChunks(20, 8)
    expect(chunks).toEqual([
      { index: 0, start: 0, end: 7 },
      { index: 1, start: 8, end: 15 },
      { index: 2, start: 16, end: 19 } // partial final chunk, 4 bytes
    ])
  })

  it('covers every byte with no overlaps or gaps across many chunks', () => {
    const size = 8 * 1024 * 1024 * 3 + 12345
    const chunks = planChunks(size, DEFAULT_CHUNK_SIZE)
    let expectedStart = 0
    for (const c of chunks) {
      expect(c.start).toBe(expectedStart)
      expect(c.end).toBeGreaterThanOrEqual(c.start)
      expectedStart = c.end + 1
    }
    expect(expectedStart).toBe(size)
  })

  it('defaults to an 8 MiB chunk size', () => {
    const chunks = planChunks(DEFAULT_CHUNK_SIZE + 1)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].end - chunks[0].start + 1).toBe(DEFAULT_CHUNK_SIZE)
    expect(chunks[1].end - chunks[1].start + 1).toBe(1)
  })
})

describe('findMissingChunks', () => {
  const chunks = planChunks(50, 10) // 5 chunks of 10 bytes each

  it('returns every chunk when nothing is stored', () => {
    expect(findMissingChunks(chunks, {})).toEqual(chunks)
  })

  it('returns nothing when every chunk is fully stored', () => {
    const stored = { 0: 10, 1: 10, 2: 10, 3: 10, 4: 10 }
    expect(findMissingChunks(chunks, stored)).toEqual([])
  })

  it('finds gaps in the middle of the sequence', () => {
    const stored = { 0: 10, 2: 10, 4: 10 } // 1 and 3 missing
    const missing = findMissingChunks(chunks, stored)
    expect(missing.map((c) => c.index)).toEqual([1, 3])
  })

  it('treats a short/partial write as missing, not as stored', () => {
    const stored = { 0: 10, 1: 6, 2: 10, 3: 10, 4: 10 } // chunk 1 truncated
    const missing = findMissingChunks(chunks, stored)
    expect(missing.map((c) => c.index)).toEqual([1])
  })

  it('accepts a Map as well as a plain object', () => {
    const stored = new Map([[0, 10], [1, 10], [2, 10], [3, 10]])
    const missing = findMissingChunks(chunks, stored)
    expect(missing.map((c) => c.index)).toEqual([4])
  })
})

describe('chunkKey', () => {
  it('combines bookId, fileIndex, chunkIndex into a distinct key', () => {
    expect(chunkKey('b1a2b3', 2, 17)).toBe('b1a2b3::2::17')
    expect(chunkKey('b1a2b3', 2, 17)).not.toBe(chunkKey('b1a2b3', 2, 18))
    expect(chunkKey('b1a2b3', 2, 17)).not.toBe(chunkKey('b1a2b3', 3, 17))
    expect(chunkKey('b1a2b3', 2, 17)).not.toBe(chunkKey('other', 2, 17))
  })
})

describe('sumFileByteLengths', () => {
  it('sums resolved byte lengths', () => {
    expect(sumFileByteLengths([{ byteLength: 100 }, { byteLength: 250 }])).toBe(350)
  })

  it('treats an unresolved (null) byteLength as 0, not as unknown-blocking', () => {
    expect(sumFileByteLengths([{ byteLength: 100 }, { byteLength: null }])).toBe(100)
  })

  it('returns 0 for an empty or missing file list', () => {
    expect(sumFileByteLengths([])).toBe(0)
    expect(sumFileByteLengths(undefined)).toBe(0)
  })
})

describe('formatBytes', () => {
  it('formats 0 and invalid sizes as "0 MB" (matches the mobile UI convention)', () => {
    expect(formatBytes(0)).toBe('0 MB')
    expect(formatBytes(-5)).toBe('0 MB')
    expect(formatBytes(NaN)).toBe('0 MB')
    expect(formatBytes(undefined)).toBe('0 MB')
  })

  it('formats sub-KB sizes as whole bytes', () => {
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('crosses the KB boundary at exactly 1024', () => {
    expect(formatBytes(1024)).toBe('1.00 KB')
  })

  it('crosses the MB boundary at exactly 1024 * 1024', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB')
  })

  it('crosses the GB boundary at exactly 1024^3', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB')
  })

  it('uses fewer decimals as the magnitude grows within a unit', () => {
    expect(formatBytes(10 * 1024)).toBe('10.0 KB')
    expect(formatBytes(100 * 1024)).toBe('100 KB')
  })
})

describe('finalizeDownloadOutcome', () => {
  it('reports complete when stored bytes exactly match the summed Content-Length', () => {
    expect(finalizeDownloadOutcome({ bytesTotal: 1000, bytesDone: 1000 })).toEqual({ status: 'complete', error: null })
  })

  it('reports an integrity mismatch when stored bytes fall short of the total', () => {
    expect(finalizeDownloadOutcome({ bytesTotal: 1000, bytesDone: 900 })).toEqual({
      status: 'error',
      error: 'integrity_mismatch'
    })
  })

  it('never reports complete for a zero bytesTotal, even though 0 === 0', () => {
    expect(finalizeDownloadOutcome({ bytesTotal: 0, bytesDone: 0 })).toEqual({ status: 'error', error: 'empty_download' })
  })

  it('defaults missing facts to 0 and still reports empty_download, not complete', () => {
    expect(finalizeDownloadOutcome()).toEqual({ status: 'error', error: 'empty_download' })
  })
})

describe('validateChunkResponse', () => {
  it('accepts 206 Partial Content for a multi-chunk file', () => {
    expect(validateChunkResponse({ status: 206, totalChunksForFile: 5 })).toEqual({ valid: true })
  })

  it('accepts 200 only when the file has exactly one planned chunk', () => {
    expect(validateChunkResponse({ status: 200, totalChunksForFile: 1 })).toEqual({ valid: true })
  })

  it('rejects 200 for a multi-chunk file (a Range-stripping proxy returned the whole file)', () => {
    const result = validateChunkResponse({ status: 200, totalChunksForFile: 5 })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('range_not_honored')
  })

  it('rejects any other status regardless of chunk count', () => {
    expect(validateChunkResponse({ status: 404, totalChunksForFile: 1 }).valid).toBe(false)
    expect(validateChunkResponse({ status: 500, totalChunksForFile: 5 }).valid).toBe(false)
  })

  it('passes a status-only pre-check when blobSize/expectedSize are not yet known', () => {
    expect(validateChunkResponse({ status: 206, totalChunksForFile: 3 })).toEqual({ valid: true })
  })

  it('rejects a size mismatch even with a valid status (truncated/extended body)', () => {
    const result = validateChunkResponse({ status: 206, totalChunksForFile: 3, blobSize: 100, expectedSize: 8388608 })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('size_mismatch')
  })

  it('accepts a matching size on a valid status', () => {
    expect(validateChunkResponse({ status: 206, totalChunksForFile: 3, blobSize: 4096, expectedSize: 4096 })).toEqual({
      valid: true
    })
  })
})

describe('deriveDownloadState', () => {
  it('reports none when nothing has been stored', () => {
    expect(deriveDownloadState({ bytesTotal: 1000, bytesDone: 0 })).toBe('none')
    expect(deriveDownloadState()).toBe('none')
  })

  it('reports none (never complete) when both bytesTotal and bytesDone are 0', () => {
    expect(deriveDownloadState({ bytesTotal: 0, bytesDone: 0 })).toBe('none')
  })

  it('reports partial when some but not all bytes are stored', () => {
    expect(deriveDownloadState({ bytesTotal: 1000, bytesDone: 500 })).toBe('partial')
  })

  it('reports complete when bytesDone reaches bytesTotal', () => {
    expect(deriveDownloadState({ bytesTotal: 1000, bytesDone: 1000 })).toBe('complete')
  })

  it('reports downloading whenever a fetch is active, regardless of byte counts', () => {
    expect(deriveDownloadState({ bytesTotal: 1000, bytesDone: 0, isActive: true })).toBe('downloading')
    expect(deriveDownloadState({ bytesTotal: 1000, bytesDone: 500, isActive: true })).toBe('downloading')
  })

  it('error takes priority over an active flag', () => {
    expect(deriveDownloadState({ bytesTotal: 1000, bytesDone: 500, isActive: true, hasError: true })).toBe('error')
  })

  it('reports error whenever hasError is set, regardless of byte counts', () => {
    expect(deriveDownloadState({ bytesTotal: 1000, bytesDone: 1000, hasError: true })).toBe('error')
  })
})

describe('collapsePositionQueue', () => {
  it('keeps the newest entry per (bookId, fileIndex)', () => {
    const entries = [
      { bookId: 'b1', fileIndex: 0, seconds: 10, queuedAt: 1 },
      { bookId: 'b1', fileIndex: 0, seconds: 40, queuedAt: 2 },
      { bookId: 'b1', fileIndex: 0, seconds: 90, queuedAt: 3 }
    ]
    expect(collapsePositionQueue(entries)).toEqual([{ bookId: 'b1', fileIndex: 0, seconds: 90, queuedAt: 3 }])
  })

  it('preserves queuedAt-order (not array-order) first-appearance across multiple interleaved books', () => {
    const entries = [
      { bookId: 'b1', fileIndex: 0, seconds: 10, queuedAt: 1 },
      { bookId: 'b2', fileIndex: 0, seconds: 5, queuedAt: 2 },
      { bookId: 'b1', fileIndex: 0, seconds: 20, queuedAt: 3 },
      { bookId: 'b3', fileIndex: 1, seconds: 1, queuedAt: 4 },
      { bookId: 'b2', fileIndex: 0, seconds: 55, queuedAt: 5 },
      { bookId: 'b1', fileIndex: 0, seconds: 30, queuedAt: 6 }
    ]
    expect(collapsePositionQueue(entries)).toEqual([
      { bookId: 'b1', fileIndex: 0, seconds: 30, queuedAt: 6 },
      { bookId: 'b2', fileIndex: 0, seconds: 55, queuedAt: 5 },
      { bookId: 'b3', fileIndex: 1, seconds: 1, queuedAt: 4 }
    ])
  })

  it('sorts by queuedAt rather than trusting array/insertion order — shuffled input', () => {
    // Deliberately out of chronological order: array position no longer
    // matches queuedAt, simulating an out-of-order cursor result.
    const entries = [
      { bookId: 'b1', fileIndex: 0, seconds: 999, queuedAt: 100 }, // actually the newest
      { bookId: 'b2', fileIndex: 0, seconds: 1, queuedAt: 10 },
      { bookId: 'b1', fileIndex: 0, seconds: 1, queuedAt: 20 }, // actually the oldest for b1
      { bookId: 'b2', fileIndex: 0, seconds: 2, queuedAt: 30 }
    ]
    const collapsed = collapsePositionQueue(entries)
    expect(collapsed).toEqual([
      { bookId: 'b2', fileIndex: 0, seconds: 2, queuedAt: 30 },
      { bookId: 'b1', fileIndex: 0, seconds: 999, queuedAt: 100 }
    ])
  })

  it('treats different fileIndex values on the same book as distinct keys', () => {
    const entries = [
      { bookId: 'b1', fileIndex: 0, seconds: 10, queuedAt: 1 },
      { bookId: 'b1', fileIndex: 1, seconds: 3, queuedAt: 2 },
      { bookId: 'b1', fileIndex: 0, seconds: 15, queuedAt: 3 }
    ]
    expect(collapsePositionQueue(entries)).toEqual([
      { bookId: 'b1', fileIndex: 0, seconds: 15, queuedAt: 3 },
      { bookId: 'b1', fileIndex: 1, seconds: 3, queuedAt: 2 }
    ])
  })

  it('falls back to stable input order when queuedAt is absent on every entry', () => {
    const entries = [
      { bookId: 'b1', fileIndex: 0, seconds: 10 },
      { bookId: 'b1', fileIndex: 0, seconds: 40 },
      { bookId: 'b1', fileIndex: 0, seconds: 90 }
    ]
    expect(collapsePositionQueue(entries)).toEqual([{ bookId: 'b1', fileIndex: 0, seconds: 90 }])
  })

  it('falls back to plain input order (not a mixed-scale sort) when only SOME entries have queuedAt', () => {
    // Regression: naively substituting the array index for a missing
    // queuedAt would compare ~1.7e12ms timestamps against tiny indices,
    // so every unstamped row would sort as impossibly old and always lose
    // to every stamped row — silently inverting the real order instead of
    // just falling back to it. The fix is to fall back to plain input
    // order for the whole list whenever even one entry is unstamped.
    const entries = [
      { bookId: 'b1', fileIndex: 0, seconds: 1, queuedAt: 9_999_999_999 }, // huge, "newest" by timestamp
      { bookId: 'b1', fileIndex: 0, seconds: 2 } // no queuedAt, but comes later in the input
    ]
    // Input order wins: the second (unstamped, later-in-input) entry is
    // the one collapsePositionQueue keeps, not the falsely-"older" one.
    expect(collapsePositionQueue(entries)).toEqual([{ bookId: 'b1', fileIndex: 0, seconds: 2 }])
  })

  it('returns an empty array for an empty or missing queue', () => {
    expect(collapsePositionQueue([])).toEqual([])
    expect(collapsePositionQueue(undefined)).toEqual([])
  })
})

describe('resolveLatestQueuedPosition', () => {
  it('returns null when nothing is queued for the book', () => {
    expect(resolveLatestQueuedPosition([], 'b1')).toBeNull()
    expect(resolveLatestQueuedPosition(undefined, 'b1')).toBeNull()
    expect(
      resolveLatestQueuedPosition([{ bookId: 'other', fileIndex: 0, seconds: 5, queuedAt: 1 }], 'b1')
    ).toBeNull()
  })

  it('returns the newest entry when fileIndex only ever increases', () => {
    const entries = [
      { bookId: 'b1', fileIndex: 0, seconds: 10, queuedAt: 1 },
      { bookId: 'b1', fileIndex: 1, seconds: 20, queuedAt: 2 },
      { bookId: 'b1', fileIndex: 2, seconds: 5, queuedAt: 3 }
    ]
    expect(resolveLatestQueuedPosition(entries, 'b1')).toEqual({ fileIndex: 2, seconds: 5 })
  })

  it('lets a later write to an earlier fileIndex win (backwards chapter jump)', () => {
    const entries = [
      { bookId: 'b1', fileIndex: 0, seconds: 10, queuedAt: 1 },
      { bookId: 'b1', fileIndex: 2, seconds: 500, queuedAt: 2 }, // played forward to chapter 3
      { bookId: 'b1', fileIndex: 0, seconds: 20, queuedAt: 3 } // then jumped back to chapter 1
    ]
    expect(resolveLatestQueuedPosition(entries, 'b1')).toEqual({ fileIndex: 0, seconds: 20 })
  })

  it('resolves by queuedAt rather than array order — shuffled input', () => {
    const entries = [
      { bookId: 'b1', fileIndex: 3, seconds: 42, queuedAt: 5 }, // newest, listed first
      { bookId: 'b1', fileIndex: 0, seconds: 1, queuedAt: 1 },
      { bookId: 'b1', fileIndex: 1, seconds: 2, queuedAt: 3 }
    ]
    expect(resolveLatestQueuedPosition(entries, 'b1')).toEqual({ fileIndex: 3, seconds: 42 })
  })

  it('ignores other books interleaved in the same queue', () => {
    const entries = [
      { bookId: 'b1', fileIndex: 0, seconds: 10, queuedAt: 1 },
      { bookId: 'b2', fileIndex: 0, seconds: 999, queuedAt: 2 },
      { bookId: 'b1', fileIndex: 0, seconds: 15, queuedAt: 3 },
      { bookId: 'b3', fileIndex: 4, seconds: 1, queuedAt: 4 },
      { bookId: 'b2', fileIndex: 3, seconds: 42, queuedAt: 5 },
      { bookId: 'b1', fileIndex: 1, seconds: 2, queuedAt: 6 }
    ]
    expect(resolveLatestQueuedPosition(entries, 'b1')).toEqual({ fileIndex: 1, seconds: 2 })
    expect(resolveLatestQueuedPosition(entries, 'b2')).toEqual({ fileIndex: 3, seconds: 42 })
    expect(resolveLatestQueuedPosition(entries, 'b3')).toEqual({ fileIndex: 4, seconds: 1 })
  })
})

describe('positionQueueKey', () => {
  it('distinguishes by both bookId and fileIndex', () => {
    expect(positionQueueKey('b1', 0)).not.toBe(positionQueueKey('b1', 1))
    expect(positionQueueKey('b1', 0)).not.toBe(positionQueueKey('b2', 0))
    expect(positionQueueKey('b1', 0)).toBe(positionQueueKey('b1', 0))
  })
})

describe('queueIdsForKey', () => {
  const raw = [
    { id: 1, bookId: 'b1', fileIndex: 0, seconds: 10 },
    { id: 2, bookId: 'b1', fileIndex: 0, seconds: 20 },
    { id: 3, bookId: 'b1', fileIndex: 1, seconds: 1 },
    { id: 4, bookId: 'b2', fileIndex: 0, seconds: 5 }
  ]

  it('returns every raw id matching the (bookId, fileIndex) pair', () => {
    expect(queueIdsForKey(raw, 'b1', 0)).toEqual([1, 2])
  })

  it('returns an empty array when nothing matches', () => {
    expect(queueIdsForKey(raw, 'b1', 9)).toEqual([])
    expect(queueIdsForKey(raw, 'missing', 0)).toEqual([])
  })

  it('does not cross book boundaries for the same fileIndex', () => {
    expect(queueIdsForKey(raw, 'b2', 0)).toEqual([4])
  })
})

describe('isPermanentQueueFailure', () => {
  it('treats most 4xx statuses as permanent', () => {
    expect(isPermanentQueueFailure(400)).toBe(true)
    expect(isPermanentQueueFailure(404)).toBe(true)
    expect(isPermanentQueueFailure(499)).toBe(true)
  })

  it('does NOT treat 401 as permanent — an expired/regenerated PIN session must not wipe the queue', () => {
    // The single highest-value case here: if this were `true`, the first
    // queued entry to hit a 401 (session expired, e.g. the PIN was
    // regenerated on the desktop) would get discarded — and every entry
    // after it in the same flush, since they'd all 401 too — silently
    // wiping hours of offline listening progress instead of just pausing
    // the flush until the user re-authenticates.
    expect(isPermanentQueueFailure(401)).toBe(false)
  })

  it('does not treat 408 (timeout) or 429 (rate-limited) as permanent either', () => {
    expect(isPermanentQueueFailure(408)).toBe(false)
    expect(isPermanentQueueFailure(429)).toBe(false)
  })

  it('treats 5xx and other statuses as not permanent (retry later)', () => {
    expect(isPermanentQueueFailure(500)).toBe(false)
    expect(isPermanentQueueFailure(503)).toBe(false)
    expect(isPermanentQueueFailure(200)).toBe(false)
    expect(isPermanentQueueFailure(399)).toBe(false)
  })

  it('treats a missing status (network-level failure) as not permanent', () => {
    expect(isPermanentQueueFailure(null)).toBe(false)
    expect(isPermanentQueueFailure(undefined)).toBe(false)
  })
})

describe('nextQueueAction', () => {
  it('commits on success (no error)', () => {
    expect(nextQueueAction(null)).toBe('commit')
    expect(nextQueueAction(undefined)).toBe('commit')
  })

  it('discards on a permanent failure (e.g. 404)', () => {
    expect(nextQueueAction(Object.assign(new Error('not_found'), { status: 404 }))).toBe('discard')
  })

  it('stops on a 401 rather than discarding — session expiry must pause, not wipe, the queue', () => {
    expect(nextQueueAction(Object.assign(new Error('unauthorized'), { status: 401 }))).toBe('stop')
  })

  it('stops on a network-level failure with no status', () => {
    expect(nextQueueAction(new Error('offline'))).toBe('stop')
  })

  it('stops on a transient 5xx', () => {
    expect(nextQueueAction(Object.assign(new Error('server_error'), { status: 500 }))).toBe('stop')
  })
})

describe('queue replay composition (exercises the exact functions offline.js\'s flushPositionQueue calls, in the same order)', () => {
  // This composes collapsePositionQueue -> nextQueueAction -> queueIdsForKey
  // exactly as offline.js's loop does (see flushPositionQueue), rather than
  // re-implementing the permanent/transient branching locally — so a change
  // to the real decision logic (nextQueueAction/isPermanentQueueFailure)
  // would be caught here, not silently diverge from what's tested.
  function simulateFlush(raw, errorForBookId) {
    const collapsed = collapsePositionQueue(raw)
    const posted = []
    const remainingIds = new Set(raw.map((r) => r.id))
    for (const entry of collapsed) {
      const err = errorForBookId(entry.bookId) || null
      const action = nextQueueAction(err)
      if (action === 'stop') break
      if (action === 'commit') posted.push(entry)
      for (const id of queueIdsForKey(raw, entry.bookId, entry.fileIndex)) remainingIds.delete(id)
    }
    return { posted, remainingIds }
  }

  it('discards an entry that 404s forever instead of blocking every other queued book', () => {
    // b1's id has "regenerated" (re-imported on desktop) — POST /api/position
    // now 404s for it permanently. b2 and b3 are healthy.
    const raw = [
      { id: 1, bookId: 'b1', fileIndex: 0, seconds: 10, queuedAt: 1 },
      { id: 2, bookId: 'b2', fileIndex: 0, seconds: 20, queuedAt: 2 },
      { id: 3, bookId: 'b3', fileIndex: 1, seconds: 30, queuedAt: 3 }
    ]
    const { posted, remainingIds } = simulateFlush(raw, (bookId) =>
      bookId === 'b1' ? Object.assign(new Error('not_found'), { status: 404 }) : null
    )

    expect(posted.map((e) => e.bookId)).toEqual(['b2', 'b3'])
    expect(remainingIds.size).toBe(0) // b1's unpostable entry was discarded, not left stuck at the head
  })

  it('stops at the first network-level failure and leaves the rest queued', () => {
    const raw = [
      { id: 1, bookId: 'b1', fileIndex: 0, seconds: 10, queuedAt: 1 },
      { id: 2, bookId: 'b2', fileIndex: 0, seconds: 20, queuedAt: 2 }
    ]
    const { posted, remainingIds } = simulateFlush(raw, (bookId) => (bookId === 'b1' ? new Error('offline') : null))

    expect(posted).toEqual([])
    expect(remainingIds).toEqual(new Set([1, 2])) // nothing retired — still offline
  })

  it('a 401 pauses the whole flush instead of wiping every remaining queued book', () => {
    // Regression for the blocking finding: with a buggy isPermanentQueueFailure
    // treating 401 as permanent, this would discard all three entries.
    const raw = [
      { id: 1, bookId: 'b1', fileIndex: 0, seconds: 10, queuedAt: 1 },
      { id: 2, bookId: 'b2', fileIndex: 0, seconds: 20, queuedAt: 2 },
      { id: 3, bookId: 'b3', fileIndex: 1, seconds: 30, queuedAt: 3 }
    ]
    const { posted, remainingIds } = simulateFlush(raw, () => Object.assign(new Error('unauthorized'), { status: 401 }))

    expect(posted).toEqual([])
    expect(remainingIds).toEqual(new Set([1, 2, 3])) // every entry survives the 401
  })
})

describe('filesToWarm', () => {
  it('warms every file index for a fully-downloaded book, not just neighbours', () => {
    expect(filesToWarm(0, 5, true)).toEqual([0, 1, 2, 3, 4])
    expect(filesToWarm(4, 5, true)).toEqual([0, 1, 2, 3, 4]) // current index doesn't matter once complete
  })

  it('warms only the immediate neighbours for a partial download', () => {
    expect(filesToWarm(2, 5, false)).toEqual([1, 2, 3])
  })

  it('clamps neighbours to the valid range at the start and end of the book', () => {
    expect(filesToWarm(0, 5, false)).toEqual([0, 1])
    expect(filesToWarm(4, 5, false)).toEqual([3, 4])
  })

  it('returns just the single file for a one-file book', () => {
    expect(filesToWarm(0, 1, false)).toEqual([0])
    expect(filesToWarm(0, 1, true)).toEqual([0])
  })

  it('returns an empty array for a zero/invalid file count', () => {
    expect(filesToWarm(0, 0, true)).toEqual([])
    expect(filesToWarm(0, 0, false)).toEqual([])
    expect(filesToWarm(0, NaN, true)).toEqual([])
  })

  it('treats a non-finite currentIndex as 0 rather than throwing', () => {
    expect(filesToWarm(NaN, 3, false)).toEqual([0, 1])
  })
})

describe('findOrphanDownloads', () => {
  const downloads = [
    { bookId: 'b1', title: 'Alpha', author: 'A. Author', bytesTotal: 1000 },
    { bookId: 'b2', title: 'Beta', author: 'B. Author', bytesTotal: 2000 },
    { bookId: 'b3', title: 'Gamma', author: 'C. Author', bytesTotal: 3000 }
  ]

  it('flags downloads whose bookId is no longer in the live library', () => {
    const orphans = findOrphanDownloads(downloads, new Set(['b1', 'b3']))
    expect(orphans).toEqual([{ bookId: 'b2', title: 'Beta', author: 'B. Author', bytesTotal: 2000 }])
  })

  it('accepts a plain array of live ids, not just a Set', () => {
    const orphans = findOrphanDownloads(downloads, ['b1', 'b2', 'b3'])
    expect(orphans).toEqual([])
  })

  it('returns everything when the live library is empty', () => {
    const orphans = findOrphanDownloads(downloads, [])
    expect(orphans.map((o) => o.bookId)).toEqual(['b1', 'b2', 'b3'])
  })

  it('returns an empty array when there are no downloads', () => {
    expect(findOrphanDownloads([], ['b1'])).toEqual([])
    expect(findOrphanDownloads(undefined, ['b1'])).toEqual([])
  })
})
