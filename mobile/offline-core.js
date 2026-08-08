// mobile/offline-core.js
//
// Pure logic for the offline download engine — no IndexedDB, no DOM, no
// fetch. Every function here is a plain data-in/data-out transform so it can
// be unit-tested under plain node (see tests/offlineCore.test.js). The
// IndexedDB/fetch orchestration that calls into this module lives in
// offline.js.
//
// This is loaded as a native ES module (no build step, no bundler) — see the
// mobile/ README notes in offline.js for why.

'use strict';

// Each media file is stored as a sequence of ~8 MB Blobs rather than one
// giant ArrayBuffer/Blob. Reasons (see offline.js for the full rationale):
// ranged fetches give real progress, a cancelled/failed download resumes
// from the last stored chunk instead of restarting, and reassembling many
// small Blobs with `new Blob([...])` at playback time stays disk-backed in
// Safari instead of pulling the whole book into RAM.
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB

const KEY_SEP = '::';

// ---------------------------------------------------------------------
// Chunk planning
// ---------------------------------------------------------------------

/**
 * Splits a file of `byteLength` bytes into a sequence of chunk byte ranges,
 * each inclusive on both ends (matches HTTP Range semantics: a fetch for
 * chunk {start, end} is `Range: bytes=${start}-${end}`, and end IS included
 * in the response). A zero or invalid byteLength yields no chunks.
 *
 * @param {number} byteLength
 * @param {number} [chunkSize]
 * @returns {Array<{index: number, start: number, end: number}>}
 */
export function planChunks(byteLength, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return [];
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) chunkSize = DEFAULT_CHUNK_SIZE;

  const chunks = [];
  let start = 0;
  let index = 0;
  while (start < byteLength) {
    const end = Math.min(start + chunkSize, byteLength) - 1; // inclusive
    chunks.push({ index, start, end });
    start += chunkSize;
    index += 1;
  }
  return chunks;
}

/**
 * Given the chunks a file is planned to have and the byte sizes actually
 * stored so far (keyed by chunk index), returns the chunks that are still
 * missing — either never stored, or stored short (a partial/corrupt write
 * from an interrupted fetch). Resuming trusts these stored *sizes*, not a
 * counter, so a chunk that was only half-written before a crash is
 * correctly re-fetched rather than treated as done.
 *
 * @param {Array<{index:number,start:number,end:number}>} chunks
 * @param {Map<number, number> | Record<number, number>} storedSizes
 */
export function findMissingChunks(chunks, storedSizes) {
  const getStoredSize = (i) => {
    if (storedSizes instanceof Map) return storedSizes.get(i);
    return storedSizes ? storedSizes[i] : undefined;
  };
  return (chunks || []).filter((c) => {
    const expected = c.end - c.start + 1;
    return getStoredSize(c.index) !== expected;
  });
}

// ---------------------------------------------------------------------
// Chunk key construction / parsing
// ---------------------------------------------------------------------

/** Builds the IndexedDB key for one stored chunk. */
export function chunkKey(bookId, fileIndex, chunkIndex) {
  return `${bookId}${KEY_SEP}${fileIndex}${KEY_SEP}${chunkIndex}`;
}

// ---------------------------------------------------------------------
// Storage accounting
// ---------------------------------------------------------------------

/**
 * Sums the known byte lengths of a book's resolved files (from HEAD
 * Content-Length lookups). Files whose byteLength hasn't been resolved yet
 * (null/not-a-number) contribute 0 — this is a best-effort total for a
 * still-resolving download, not a claim that every size is known; callers
 * check that separately (every file has a finite byteLength) before
 * treating the total as authoritative.
 *
 * @param {Array<{byteLength: number|null}>} files
 */
export function sumFileByteLengths(files) {
  return (files || []).reduce((sum, f) => sum + (Number.isFinite(f?.byteLength) ? f.byteLength : 0), 0);
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * Human-readable size, e.g. "482 B", "1.2 KB", "8.4 MB", "1.2 GB". This is
 * the single implementation — the UI imports this rather than keeping its
 * own copy. "0 MB" (not "0 B") for zero/invalid input is a deliberate
 * choice to match the existing mobile UI convention for "no size yet
 * known" download rows.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${SIZE_UNITS[unitIndex]}`;
}

/**
 * Verifies a completed download's actual stored bytes against the summed
 * Content-Length before ever calling it 'complete' — and, critically,
 * treats a zero bytesTotal as a failure rather than a trivially-satisfied
 * "0 === 0" success. A zero total means every file size failed to resolve
 * (e.g. a proxy that silently drops Content-Length on HEAD) or the book
 * has no files; either way there is nothing genuinely downloaded, and
 * reporting 'complete' would let a user board a plane with an empty
 * download.
 *
 * @param {{bytesTotal?: number, bytesDone?: number}} facts
 * @returns {{status: 'complete'|'error', error: null|'empty_download'|'integrity_mismatch'}}
 */
export function finalizeDownloadOutcome({ bytesTotal = 0, bytesDone = 0 } = {}) {
  if (!(bytesTotal > 0)) return { status: 'error', error: 'empty_download' };
  if (bytesDone !== bytesTotal) return { status: 'error', error: 'integrity_mismatch' };
  return { status: 'complete', error: null };
}

/**
 * Validates one ranged chunk fetch before its body is trusted/stored.
 * Called in two passes by the caller: once right after the response
 * headers arrive (status only, blobSize/expectedSize omitted) so a bad
 * response can be rejected *before* paying to read a potentially huge
 * body, and again after `res.blob()` to catch a size mismatch.
 *
 * A Range-stripping intermediary answering a ranged request with a plain
 * 200 (the whole file) is exactly the failure mode this exists to catch —
 * for a file with more than one planned chunk, a 200 is never acceptable,
 * because storing "the whole file" under every one of that file's chunk
 * keys would multiply its real size by its chunk count before ever
 * failing (e.g. a 500 MB book writing ~31 GB before hitting quota). A 200
 * is only legitimate when the file has exactly one planned chunk, since a
 * whole-file response and a "chunk 0 of 1" response are byte-identical.
 *
 * @param {{status:number, totalChunksForFile?:number, blobSize?:number, expectedSize?:number}} params
 * @returns {{valid:boolean, reason?:string}}
 */
export function validateChunkResponse({ status, totalChunksForFile = 1, blobSize, expectedSize } = {}) {
  const statusOk = status === 206 || (status === 200 && totalChunksForFile <= 1);
  if (!statusOk) return { valid: false, reason: 'range_not_honored' };
  if (blobSize != null && expectedSize != null && blobSize !== expectedSize) {
    return { valid: false, reason: 'size_mismatch' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------
// Download-state derivation
// ---------------------------------------------------------------------

/**
 * Derives the public download status from stored facts. `hasError` wins
 * over everything (a failed download stays 'error' until retried), then an
 * in-flight fetch reports 'downloading', then byte counts decide
 * none/partial/complete. bytesDone <= 0 is 'none' even if a download was
 * technically started — nothing has actually landed on disk yet, so there
 * is nothing to resume from that a fresh start wouldn't also produce.
 *
 * @param {{bytesTotal?: number, bytesDone?: number, isActive?: boolean, hasError?: boolean}} facts
 * @returns {'none'|'partial'|'downloading'|'complete'|'error'}
 */
export function deriveDownloadState({ bytesTotal = 0, bytesDone = 0, isActive = false, hasError = false } = {}) {
  if (hasError) return 'error';
  if (isActive) return 'downloading';
  if (!(bytesDone > 0)) return 'none';
  if (bytesTotal > 0 && bytesDone >= bytesTotal) return 'complete';
  return 'partial';
}

// ---------------------------------------------------------------------
// Position queue (offline position POSTs)
// ---------------------------------------------------------------------

/** Groups a queued position entry by the (bookId, fileIndex) it targets. */
export function positionQueueKey(bookId, fileIndex) {
  return `${bookId}${KEY_SEP}${fileIndex}`;
}

/**
 * Orders queued entries by their `queuedAt` timestamp rather than trusting
 * whatever order the caller handed them in (e.g. IndexedDB autoIncrement
 * primary-key order, which is *usually* insertion order but isn't a
 * guarantee anything here should lean on — an out-of-order cursor result or
 * a caller merging queues from elsewhere could invert it).
 *
 * If *every* entry has a finite `queuedAt`, sort by it (stable: ties keep
 * their original relative order). If even one entry is missing it, fall
 * back to the original input order for *all* entries rather than mixing
 * epoch-millisecond timestamps (~1.7e12) with a small per-entry index as a
 * substitute — that would sort every unstamped row ahead of every stamped
 * one (a `~1970 + i` ms row always loses to a `~2026` ms row), silently
 * inverting the real order instead of just falling back to it.
 */
function sortByQueuedAt(entries) {
  const list = entries || [];
  const allStamped = list.length > 0 && list.every((e) => Number.isFinite(e.queuedAt));
  if (!allStamped) return list.slice();
  return list
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => (a.entry.queuedAt !== b.entry.queuedAt ? a.entry.queuedAt - b.entry.queuedAt : a.i - b.i))
    .map((x) => x.entry);
}

/**
 * Collapses a list of queued position entries down to one entry per
 * (bookId, fileIndex) — the newest one for that pair by `queuedAt`, since
 * replaying a stale earlier position would move the user's playback
 * position backwards. The *output* order is the order in which each
 * (bookId, fileIndex) pair first appears once the input is sorted by
 * `queuedAt`, so multiple interleaved books still replay in a stable,
 * predictable order; only the value picked for each pair is the latest
 * one seen.
 *
 * @param {Array<{bookId:string, fileIndex:number, seconds:number, queuedAt?:number}>} entries
 */
export function collapsePositionQueue(entries) {
  const ordered = sortByQueuedAt(entries);
  const order = [];
  const latestByKey = new Map();
  for (const entry of ordered) {
    const key = positionQueueKey(entry.bookId, entry.fileIndex);
    if (!latestByKey.has(key)) order.push(key);
    latestByKey.set(key, entry);
  }
  return order.map((key) => latestByKey.get(key));
}

/**
 * Resolves the single most recent queued position for a book, across every
 * fileIndex it has queued entries for — not the entry with the highest
 * fileIndex. A user can jump backwards through chapters (fileIndex goes
 * down) while still producing the most recent write, and that's the
 * position that must win: it reflects where the user actually is, not
 * where they've been furthest into the book. Ordering is by `queuedAt`
 * (see sortByQueuedAt()), not input order.
 *
 * @param {Array<{bookId:string, fileIndex:number, seconds:number, queuedAt?:number}>} entries
 * @param {string} bookId
 * @returns {{fileIndex:number, seconds:number}|null}
 */
export function resolveLatestQueuedPosition(entries, bookId) {
  const ordered = sortByQueuedAt(entries);
  let latest = null;
  for (const entry of ordered) {
    if (entry.bookId === bookId) latest = entry;
  }
  return latest ? { fileIndex: latest.fileIndex, seconds: latest.seconds } : null;
}

/**
 * Every raw queued row (not yet collapsed) that targets the same
 * (bookId, fileIndex) as the given pair — i.e. every row superseded once
 * one representative entry for that pair has been posted (successfully or
 * permanently-failed) and should be retired from the queue together.
 *
 * @param {Array<{id:*, bookId:string, fileIndex:number}>} entries
 */
export function queueIdsForKey(entries, bookId, fileIndex) {
  return (entries || []).filter((e) => e.bookId === bookId && e.fileIndex === fileIndex).map((e) => e.id);
}

/**
 * Classifies a failed queue replay as permanent (discard and move on) vs.
 * transient (stop and retry the whole flush later). A 4xx from
 * POST /api/position is *usually* permanent — a 404 because the book's id
 * regenerated after a re-import (see findOrphanDownloads()) or a 400 from a
 * now-out-of-range fileIndex — replaying it will never succeed, and letting
 * it sit at the head of the queue forever would block every other book's
 * position from ever syncing again.
 *
 * 401, 408 and 429 are explicitly carved out of that "4xx = permanent"
 * rule despite being in the range: a 401 means the session/PIN cookie is no
 * longer valid (e.g. the PIN was regenerated — see main.js's PIN-reset
 * flow), 408 is a request timeout, and 429 is rate-limiting — all three are
 * recoverable once the user re-authenticates or backs off, not "this
 * specific position can never be posted". Treating 401 as permanent would
 * silently wipe the *entire* queue the moment a session expires (every
 * subsequent entry in the same flush gets discarded the same way) — this
 * is exactly the scenario the queue exists to survive, so getting this
 * carve-out right matters more than the general 4xx rule.
 *
 * The absence of a status (a thrown/rejected fetch itself, no HTTP
 * response) is a network failure and is also NOT permanent.
 *
 * Depends on the caller's postFn rejecting with an Error that carries a
 * numeric `.status` for HTTP-level failures — see flushPositionQueue() in
 * offline.js.
 *
 * @param {number|null|undefined} status
 */
export function isPermanentQueueFailure(status) {
  if (typeof status !== 'number') return false;
  if (status === 401 || status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

/**
 * The single decision `flushPositionQueue()` makes for one replayed entry,
 * given the error (if any) its postFn call rejected with. Extracted so the
 * actual decision logic is unit-testable independent of offline.js's
 * IndexedDB orchestration — offline.js's loop is a thin wrapper that calls
 * this and mechanically applies the result, rather than re-implementing
 * the branching itself.
 *
 * - 'commit': the post succeeded — retire this entry's queued rows and
 *   continue to the next one.
 * - 'discard': the post failed permanently (see isPermanentQueueFailure) —
 *   this entry can never succeed either; retire its rows anyway and
 *   continue, so one unpostable book doesn't block every other book.
 * - 'stop': a transient/network failure — leave this entry and everything
 *   after it queued, and stop the flush for this attempt.
 *
 * @param {Error & {status?: number}|null} err - null/undefined on success
 * @returns {'commit'|'discard'|'stop'}
 */
export function nextQueueAction(err) {
  if (!err) return 'commit';
  return isPermanentQueueFailure(err.status) ? 'discard' : 'stop';
}

// ---------------------------------------------------------------------
// Playback warming
// ---------------------------------------------------------------------

/**
 * Which file indexes of a book should have local object URLs pre-resolved
 * (via getLocalMediaUrl()) ahead of playback reaching them. For a fully
 * downloaded book every file is already on disk, so warm all of them —
 * chapter jumps of more than one file away are common (the chapters panel
 * lets a user jump anywhere) and only warming the immediate neighbours
 * would leave those jumps hitting an unresolved URL. For a still-partial
 * download, only the immediate neighbours make sense to warm since that's
 * the most that's likely to be locally available yet.
 *
 * @param {number} currentIndex
 * @param {number} fileCount
 * @param {boolean} isComplete
 * @returns {number[]} ascending, deduplicated, in-range file indexes
 */
export function filesToWarm(currentIndex, fileCount, isComplete) {
  const count = Number.isFinite(fileCount) && fileCount > 0 ? Math.floor(fileCount) : 0;
  if (count === 0) return [];

  if (isComplete) return Array.from({ length: count }, (_, i) => i);

  const idx = Number.isFinite(currentIndex) ? Math.floor(currentIndex) : 0;
  const inRange = [idx - 1, idx, idx + 1].filter((i) => i >= 0 && i < count);
  return Array.from(new Set(inRange)).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------
// Orphan detection
// ---------------------------------------------------------------------

/**
 * Book IDs are randomly generated and regenerate whenever a book is
 * re-imported on the desktop, so a downloaded book's id can simply stop
 * existing in the live library. This flags those downloads for the caller
 * to decide what to do with (offer to delete, re-link, etc) — it never
 * deletes anything itself.
 *
 * @param {Array<{bookId:string,title:string,author:string,bytesTotal:number}>} downloads
 * @param {Iterable<string>} liveLibraryIds
 */
export function findOrphanDownloads(downloads, liveLibraryIds) {
  const liveSet = liveLibraryIds instanceof Set ? liveLibraryIds : new Set(liveLibraryIds || []);
  return (downloads || [])
    .filter((d) => !liveSet.has(d.bookId))
    .map((d) => ({ bookId: d.bookId, title: d.title, author: d.author, bytesTotal: d.bytesTotal }));
}
