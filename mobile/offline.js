// mobile/offline.js
//
// IndexedDB + fetch layer for opt-in per-book offline downloads. Pure
// planning/accounting logic lives in offline-core.js (unit-tested in node);
// this file is the browser-only orchestration on top of it: opening the
// database, issuing ranged fetches, writing/reading Blobs, and reassembling
// them for playback.
//
// Why IndexedDB and not the Cache API / a Service Worker:
//   - This app is normally served over plain http:// on a LAN/Tailscale
//     address (not a secure context), so a Service Worker cannot register
//     at all, and `navigator.storage` (persist()/estimate()) is also
//     secure-context-only — both are feature-detected and degrade
//     gracefully instead of being assumed present.
//   - Safari's Cache API storage cap is far too low for audiobooks.
//   - IndexedDB works fine on insecure origins and has no such cap.
//
// Why each file is stored as a sequence of ~8 MB Blobs (see offline-core.js
// for the chunk planning itself) rather than one giant ArrayBuffer:
//   - Ranged fetches give real progress and let a cancelled/failed download
//     resume from the last stored chunk instead of restarting.
//   - At playback, chunks are reassembled with `new Blob([blobA, blobB, ...])`.
//     Blob-of-Blobs stays disk-backed in Safari; assembling from ArrayBuffers
//     would pull a 500 MB audiobook into RAM and get the tab killed by iOS.
//     `res.blob()` on each ~8 MB ranged fetch is fine to hold briefly in
//     memory — it's the *whole-book* reassembly that must never touch RAM.
//
// No npm dependencies, no build step — this is loaded as a native ES module
// (`<script type="module">`), which Safari on iOS has supported for years.

'use strict';

import * as core from './offline-core.js';

const DB_NAME = 'stacks-offline';
const DB_VERSION = 1;

// ---------------------------------------------------------------------
// URLs (mirrors mobile/app.js's coverUrl()/mediaUrl() — duplicated rather
// than imported so this module has no dependency on app.js's IIFE/DOM
// bootstrapping and can be loaded standalone).
// ---------------------------------------------------------------------
function mediaUrl(bookId, fileIndex) {
  return `/media/${encodeURIComponent(bookId)}/${fileIndex}`;
}
function coverUrl(bookId) {
  return `/cover/${encodeURIComponent(bookId)}`;
}

class HttpError extends Error {
  constructor(status) {
    super(`http_${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

class ChunkIntegrityError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ChunkIntegrityError';
  }
}

// ---------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------
let dbPromise = null;
// Only one book downloads at a time. A second downloadBook() call for a
// *different* book while this is in flight is rejected clearly (see
// downloadBook()) rather than queued or interleaved, which keeps the
// single-writer assumption in the chunk-write path simple and correct.
let activeDownload = null; // { bookId, controller, promise } | null

// updateStoredPosition() call sites (flush loop, direct-POST success) fire
// without awaiting each call, so per-book calls must be serialized in the
// order they were *invoked*, not left to race across separate get/put
// round trips — see updateStoredPosition() for what goes wrong otherwise.
const positionUpdateChains = new Map(); // bookId -> Promise (tail of that book's chain)

function serializePerBook(bookId, fn) {
  // The map only ever holds already-non-rejecting promises (see `settled`
  // below), so `prev` here is guaranteed to fulfill — `.then(fn)` alone is
  // enough to run `fn` strictly after whatever was chained before it.
  const prev = positionUpdateChains.get(bookId) || Promise.resolve();
  const run = prev.then(fn);
  const settled = run.catch(() => {});
  positionUpdateChains.set(bookId, settled);
  settled.then(() => {
    if (positionUpdateChains.get(bookId) === settled) positionUpdateChains.delete(bookId);
  });
  return run;
}

// ---------------------------------------------------------------------
// IndexedDB plumbing
// ---------------------------------------------------------------------

export function isSupported() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function upgradeSchema(db) {
  if (!db.objectStoreNames.contains('meta')) {
    db.createObjectStore('meta', { keyPath: 'bookId' });
  }
  if (!db.objectStoreNames.contains('chunks')) {
    const store = db.createObjectStore('chunks', { keyPath: 'key' });
    store.createIndex('byBook', 'bookId', { unique: false });
    store.createIndex('byBookFile', ['bookId', 'fileIndex'], { unique: false });
  }
  if (!db.objectStoreNames.contains('covers')) {
    db.createObjectStore('covers', { keyPath: 'bookId' });
  }
  if (!db.objectStoreNames.contains('positionQueue')) {
    db.createObjectStore('positionQueue', { keyPath: 'id', autoIncrement: true });
  }
}

function openDb() {
  if (!isSupported()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => upgradeSchema(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

/** Opens/upgrades the database. Safe to call repeatedly (idempotent). */
export async function init() {
  await openDb();
}

// Single-request-per-transaction helper: issues one request via `fn(store)`
// and resolves with its result once the transaction commits (not just once
// the request succeeds — this waits for the durable commit).
function idbRequest(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error || req.error);
    tx.onabort = () => reject(tx.error || req.error || new DOMException('aborted', 'AbortError'));
  });
}

function getMeta(db, bookId) {
  return idbRequest(db, 'meta', 'readonly', (store) => store.get(bookId));
}
function putMeta(db, meta) {
  return idbRequest(db, 'meta', 'readwrite', (store) => store.put(meta));
}
function deleteMetaRecord(db, bookId) {
  return idbRequest(db, 'meta', 'readwrite', (store) => store.delete(bookId));
}
function getAllMeta(db) {
  return idbRequest(db, 'meta', 'readonly', (store) => store.getAll());
}
function getCover(db, bookId) {
  return idbRequest(db, 'covers', 'readonly', (store) => store.get(bookId));
}
function putCover(db, bookId, blob) {
  return idbRequest(db, 'covers', 'readwrite', (store) => store.put({ bookId, blob }));
}
function deleteCoverRecord(db, bookId) {
  return idbRequest(db, 'covers', 'readwrite', (store) => store.delete(bookId));
}

// Read-modify-write of meta.book.position in a *single* transaction (get
// and put issued against the same IDBObjectStore instance, no `await`
// between them) rather than idbRequest()'s get-then-separate-put — two
// separate transactions leave a window between them where a differently-
// ordered concurrent call's put can land in between and get overwritten,
// regressing the stored position. Combined with serializePerBook() (which
// this is always called through) so calls for the same book can't even
// reach this out of invocation order.
function updateMetaPositionTx(db, bookId, position) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    const store = tx.objectStore('meta');
    const getReq = store.get(bookId);
    getReq.onsuccess = () => {
      const meta = getReq.result;
      if (!meta || !meta.book) return; // not downloaded — leave the transaction as a no-op
      meta.book = { ...meta.book, position };
      meta.updatedAt = Date.now();
      store.put(meta);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || getReq.error);
    tx.onabort = () => reject(tx.error || getReq.error);
  });
}

function putChunk(db, bookId, fileIndex, chunkIndex, blob) {
  const record = { key: core.chunkKey(bookId, fileIndex, chunkIndex), bookId, fileIndex, chunkIndex, size: blob.size, blob };
  return idbRequest(db, 'chunks', 'readwrite', (store) => store.put(record));
}

function getChunkRecords(db, bookId, fileIndex) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readonly');
    const idx = tx.objectStore('chunks').index('byBookFile');
    const req = idx.getAll(IDBKeyRange.only([bookId, fileIndex]));
    tx.oncomplete = () => resolve(req.result || []);
    tx.onerror = () => reject(tx.error || req.error);
    tx.onabort = () => reject(tx.error || req.error);
  });
}

async function getStoredChunkSizeMap(db, bookId, fileIndex) {
  const records = await getChunkRecords(db, bookId, fileIndex);
  const sizes = {};
  for (const r of records) sizes[r.chunkIndex] = r.size;
  return sizes;
}

function sumStoredBytesForBook(db, bookId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readonly');
    const idx = tx.objectStore('chunks').index('byBook');
    const req = idx.openCursor(IDBKeyRange.only(bookId));
    let total = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        total += cursor.value.size || 0;
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve(total);
    tx.onerror = () => reject(tx.error || req.error);
    tx.onabort = () => reject(tx.error || req.error);
  });
}

function deleteAllChunksForBook(db, bookId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    const idx = tx.objectStore('chunks').index('byBook');
    const req = idx.openCursor(IDBKeyRange.only(bookId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || req.error);
    tx.onabort = () => reject(tx.error || req.error);
  });
}

function getAllPositionQueueEntries(db) {
  return idbRequest(db, 'positionQueue', 'readonly', (store) => store.getAll());
}
function countPositionQueueEntries(db) {
  return idbRequest(db, 'positionQueue', 'readonly', (store) => store.count());
}
function addPositionQueueEntry(db, entry) {
  return idbRequest(db, 'positionQueue', 'readwrite', (store) => store.add(entry));
}
function deletePositionQueueEntries(db, ids) {
  if (!ids.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('positionQueue', 'readwrite');
    const store = tx.objectStore('positionQueue');
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------
// Download engine
// ---------------------------------------------------------------------

function emitProgress(onProgress, bookId, bytesDone, bytesTotal, fileIndex) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress({ bookId, bytesDone, bytesTotal, fileIndex });
  } catch {
    /* a throwing progress callback must not abort the download */
  }
}

async function ensureCoverCached(db, book, signal) {
  if (!book.hasCover) return;
  const existing = await getCover(db, book.id);
  if (existing) return;
  const res = await fetch(coverUrl(book.id), { credentials: 'same-origin', signal });
  if (!res.ok) return;
  const blob = await res.blob();
  await putCover(db, book.id, blob);
}

function deriveStoredStatus(meta) {
  const isActive = !!(activeDownload && activeDownload.bookId === meta.bookId);
  return core.deriveDownloadState({
    bytesTotal: meta.bytesTotal,
    bytesDone: meta.bytesDone,
    isActive,
    hasError: !!meta.error
  });
}

async function resolveFileByteLengths(db, book, meta, signal) {
  const wireFiles = Array.isArray(book.files) && book.files.length ? book.files : meta.files;
  for (const f of wireFiles) {
    let existing = meta.files.find((mf) => mf.index === f.index);
    if (!existing) {
      existing = { index: f.index, name: f.name, byteLength: null };
      meta.files.push(existing);
    }
    if (Number.isFinite(existing.byteLength)) continue;
    try {
      const res = await fetch(mediaUrl(book.id, f.index), { method: 'HEAD', credentials: 'same-origin', signal });
      if (res.ok) {
        // `res.headers.get()` returns null when the header is absent, and
        // Number(null) is 0 — without the explicit null check, a proxy
        // that drops Content-Length on HEAD would silently resolve a
        // 0-byte size instead of leaving it unresolved, which then makes
        // planChunks(0) plan nothing to fetch for that file at all.
        const raw = res.headers.get('content-length');
        const len = raw != null ? Number(raw) : NaN;
        if (Number.isFinite(len) && len > 0) existing.byteLength = len;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      // Offline/network failure resolving size — leave byteLength null,
      // it'll be retried on the next downloadBook() call.
    }
  }
  meta.files.sort((a, b) => a.index - b.index);
}

async function runDownload(book, controller, onProgress) {
  const bookId = book.id;
  const db = await openDb();
  const now = Date.now();

  let meta = await getMeta(db, bookId);
  if (!meta) {
    meta = {
      bookId,
      book,
      files: [],
      bytesTotal: 0,
      bytesDone: 0,
      status: 'none',
      error: null,
      addedAt: now,
      updatedAt: now
    };
  } else {
    meta.book = book; // refresh title/author/chapters/position in case they changed
    meta.error = null;
  }
  await putMeta(db, meta);

  // Everything below is one try block (not split across several) so that an
  // abort during the HEAD/cover phase takes the same clean-cancel path as
  // an abort mid-chunk, instead of rejecting runDownload() and surfacing a
  // misleading {status:'error', error:'unexpected'} for what was actually
  // just cancelDownload() being called.
  try {
    await ensureCoverCached(db, book, controller.signal).catch((err) => {
      if (err && err.name === 'AbortError') throw err;
      /* cover caching is otherwise best-effort, never fatal to the download */
    });

    await resolveFileByteLengths(db, book, meta, controller.signal);

    const allSizesKnown = meta.files.length > 0 && meta.files.every((f) => Number.isFinite(f.byteLength));
    if (!allSizesKnown) {
      // Could be offline (HEAD never got a response) or the server 404ing
      // (book removed). Either way, don't silently do nothing — the UI's
      // "Start download" tap needs a visible reason nothing happened.
      meta.bytesTotal = core.sumFileByteLengths(meta.files);
      meta.bytesDone = await sumStoredBytesForBook(db, bookId);
      meta.status = core.deriveDownloadState({ bytesTotal: meta.bytesTotal, bytesDone: meta.bytesDone, isActive: false, hasError: false });
      meta.updatedAt = Date.now();
      await putMeta(db, meta);
      return { status: meta.status, error: 'network' };
    }

    meta.bytesTotal = core.sumFileByteLengths(meta.files);
    meta.bytesDone = await sumStoredBytesForBook(db, bookId);
    meta.status = 'downloading';
    meta.updatedAt = Date.now();
    await putMeta(db, meta);
    emitProgress(onProgress, bookId, meta.bytesDone, meta.bytesTotal, null);

    for (const f of meta.files) {
      const plannedChunks = core.planChunks(f.byteLength);
      const storedSizes = await getStoredChunkSizeMap(db, bookId, f.index);
      const missing = core.findMissingChunks(plannedChunks, storedSizes);
      for (const chunk of missing) {
        const res = await fetch(mediaUrl(bookId, f.index), {
          credentials: 'same-origin',
          signal: controller.signal,
          headers: { Range: `bytes=${chunk.start}-${chunk.end}` }
        });
        const totalChunksForFile = plannedChunks.length;
        // Reject a bad status before ever reading the body — a
        // Range-stripping proxy answering 200 for a multi-chunk file would
        // otherwise mean downloading and storing the *entire* file on
        // every single chunk request.
        const statusCheck = core.validateChunkResponse({ status: res.status, totalChunksForFile });
        if (!statusCheck.valid) throw new HttpError(res.status);

        const blob = await res.blob();
        const expectedSize = chunk.end - chunk.start + 1;
        const sizeCheck = core.validateChunkResponse({ status: res.status, totalChunksForFile, blobSize: blob.size, expectedSize });
        if (!sizeCheck.valid) throw new ChunkIntegrityError(sizeCheck.reason);

        await putChunk(db, bookId, f.index, chunk.index, blob);
        meta.bytesDone += blob.size;
        emitProgress(onProgress, bookId, meta.bytesDone, meta.bytesTotal, f.index);
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      // Cancelled: keep every chunk already stored so the next
      // downloadBook() call resumes instead of restarting.
      meta.bytesDone = await sumStoredBytesForBook(db, bookId).catch(() => meta.bytesDone);
      meta.status = core.deriveDownloadState({ bytesTotal: meta.bytesTotal, bytesDone: meta.bytesDone, isActive: false, hasError: false });
      meta.updatedAt = Date.now();
      await putMeta(db, meta);
      return { status: meta.status };
    }
    if (err && err.name === 'QuotaExceededError') {
      // Storage full mid-download: leave already-written chunks intact
      // (nothing to roll back — each chunk commits in its own transaction)
      // and surface a clear, non-retriable-until-freed error.
      meta.status = 'error';
      meta.error = 'quota_exceeded';
      meta.updatedAt = Date.now();
      await putMeta(db, meta);
      return { status: 'error', error: 'quota_exceeded' };
    }
    // Network failure mid-chunk (offline) vs. a real HTTP/integrity error
    // get different treatment: offline is transient and should stay
    // resumable ('partial'/'none'), a bad HTTP status or a chunk that
    // failed validation is a real, reportable failure.
    const isRealError = err instanceof HttpError || err instanceof ChunkIntegrityError;
    meta.bytesDone = await sumStoredBytesForBook(db, bookId).catch(() => meta.bytesDone);
    meta.status = core.deriveDownloadState({ bytesTotal: meta.bytesTotal, bytesDone: meta.bytesDone, isActive: false, hasError: isRealError });
    meta.error = isRealError ? err.message : null;
    meta.updatedAt = Date.now();
    await putMeta(db, meta);
    return { status: meta.status, error: meta.error || 'network' };
  }

  // Integrity check: the download loop can only exit successfully once
  // every planned chunk for every file has been written, but verify actual
  // stored bytes against the summed Content-Length before calling it
  // done — catches any silent partial-write bug rather than trusting the
  // loop, and refuses to call a zero-byte total 'complete'.
  const finalBytes = await sumStoredBytesForBook(db, bookId);
  const outcome = core.finalizeDownloadOutcome({ bytesTotal: meta.bytesTotal, bytesDone: finalBytes });
  meta.bytesDone = finalBytes;
  meta.status = outcome.status;
  meta.error = outcome.error;
  meta.updatedAt = Date.now();
  await putMeta(db, meta);
  return { status: meta.status, error: meta.error };
}

/**
 * HEADs every file in the book and sums Content-Length so the UI can show
 * an exact download size before the user commits — the wire Book payload
 * only carries a per-file duration for single-file books, so this is the
 * only way to get a real byte count for multi-file audiobooks. Runs the
 * HEADs in parallel since books have few files and this is expected to run
 * synchronously with opening a "download this book?" sheet.
 *
 * @param {object} book - the wire Book object from /api/books/:id
 * @returns {Promise<{bytes: number|null, error?: string}>}
 */
export async function getRemoteSize(book) {
  if (!book || !book.id || !Array.isArray(book.files) || book.files.length === 0) {
    return { bytes: null, error: 'invalid_book' };
  }
  try {
    const lengths = await Promise.all(
      book.files.map(async (f) => {
        const res = await fetch(mediaUrl(book.id, f.index), { method: 'HEAD', credentials: 'same-origin' });
        if (!res.ok) throw new HttpError(res.status);
        // See resolveFileByteLengths() — a missing header must not be
        // treated as a 0-byte file (Number(null) === 0).
        const raw = res.headers.get('content-length');
        const len = raw != null ? Number(raw) : NaN;
        if (!Number.isFinite(len) || len <= 0) throw new Error('missing_content_length');
        return len;
      })
    );
    return { bytes: lengths.reduce((sum, n) => sum + n, 0) };
  } catch (err) {
    if (err instanceof HttpError) return { bytes: null, error: err.message };
    if (err && err.message === 'missing_content_length') return { bytes: null, error: 'missing_content_length' };
    return { bytes: null, error: 'network' };
  }
}

/**
 * @param {object} book - the wire Book object from /api/books/:id
 * @param {{onProgress?: (p: {bookId,bytesDone,bytesTotal,fileIndex}) => void}} [opts]
 * @returns {Promise<{status: string, error?: string|null}>}
 */
export async function downloadBook(book, { onProgress } = {}) {
  if (!isSupported() || !book || !book.id) return { status: 'error', error: 'unsupported' };
  try {
    await init();
  } catch {
    return { status: 'error', error: 'db_unavailable' };
  }

  if (activeDownload) {
    if (activeDownload.bookId === book.id) return activeDownload.promise;
    // One book downloads at a time — reject clearly rather than queueing
    // or interleaving two books' chunk writes against the single active
    // AbortController.
    return { status: 'error', error: 'busy' };
  }

  const controller = new AbortController();
  const promise = runDownload(book, controller, onProgress)
    .catch(() => ({ status: 'error', error: 'unexpected' }))
    .finally(() => {
      if (activeDownload && activeDownload.bookId === book.id) activeDownload = null;
    });
  activeDownload = { bookId: book.id, controller, promise };
  return promise;
}

/** Aborts in-flight fetches for bookId (no-op if it isn't the active download). Keeps stored chunks. */
export async function cancelDownload(bookId) {
  if (!activeDownload || activeDownload.bookId !== bookId) return;
  try {
    activeDownload.controller.abort();
    await activeDownload.promise;
  } catch {
    /* runDownload() resolves rather than throws on cancel; this is just a safety net */
  }
}

export async function deleteDownload(bookId) {
  await cancelDownload(bookId);
  if (!isSupported()) return;
  try {
    const db = await openDb();
    await deleteAllChunksForBook(db, bookId);
    await deleteMetaRecord(db, bookId);
    await deleteCoverRecord(db, bookId);
  } catch {
    /* best-effort delete; never throw out of the public API */
  }
}

export async function getDownloadState(bookId) {
  const empty = { status: 'none', bytesDone: 0, bytesTotal: 0, error: null };
  if (!isSupported()) return empty;
  try {
    const db = await openDb();
    const meta = await getMeta(db, bookId);
    if (!meta) return empty;
    return {
      status: deriveStoredStatus(meta),
      bytesDone: meta.bytesDone || 0,
      bytesTotal: meta.bytesTotal || 0,
      error: meta.error || null
    };
  } catch {
    return empty;
  }
}

/**
 * Updates the position stored on a downloaded book's cached wire Book (the
 * one getOfflineLibrary()/getLocalMediaUrl() callers resume from), so that
 * a play session which only ever hit the queue (every POST failed, e.g.
 * offline the whole time) — or one whose queue was fully flushed — still
 * has its progress recoverable if the app is closed and reopened with no
 * network at all. No-op if the book isn't downloaded. Never throws.
 *
 * The UI is expected to call this after every successful (direct or
 * flushed) position write, and getQueuedPosition() covers the gap for
 * anything still sitting in the queue at read time.
 *
 * Calls for the same bookId are serialized in invocation order (see
 * serializePerBook()) and each one is a single atomic get+put transaction
 * (see updateMetaPositionTx()) — without both of those, three overlapping
 * calls (e.g. a flush replaying several files in order, each followed by
 * a fire-and-forget call to this) could commit out of order and leave the
 * stored position at an earlier file than the user actually reached.
 *
 * @param {string} bookId
 * @param {{fileIndex:number, seconds:number}} position
 */
export async function updateStoredPosition(bookId, { fileIndex, seconds } = {}) {
  if (!isSupported() || !bookId || !Number.isFinite(fileIndex) || !Number.isFinite(seconds)) return;
  await serializePerBook(bookId, async () => {
    try {
      const db = await openDb();
      await updateMetaPositionTx(db, bookId, { fileIndex, seconds });
    } catch {
      /* best-effort; never throw out of the public API */
    }
  });
}

export async function listDownloads() {
  if (!isSupported()) return [];
  try {
    const db = await openDb();
    const metas = await getAllMeta(db);
    return metas.map((m) => ({
      bookId: m.bookId,
      title: m.book?.title || '',
      author: m.book?.author || '',
      bytesTotal: m.bytesTotal || 0,
      bytesDone: m.bytesDone || 0,
      status: deriveStoredStatus(m),
      addedAt: m.addedAt,
      files: m.files
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// Playback: local URLs
// ---------------------------------------------------------------------

export async function getLocalMediaUrl(bookId, fileIndex) {
  if (!isSupported()) return null;
  try {
    const db = await openDb();
    const meta = await getMeta(db, bookId);
    const fileMeta = meta?.files?.find((f) => f.index === fileIndex);
    if (!meta || !fileMeta || !Number.isFinite(fileMeta.byteLength)) return null;

    const plannedChunks = core.planChunks(fileMeta.byteLength);
    if (plannedChunks.length === 0) return null;

    const records = await getChunkRecords(db, bookId, fileIndex);
    const byIndex = new Map(records.map((r) => [r.chunkIndex, r]));
    const orderedBlobs = [];
    for (const chunk of plannedChunks) {
      const record = byIndex.get(chunk.index);
      const expectedSize = chunk.end - chunk.start + 1;
      if (!record || record.size !== expectedSize) return null; // incomplete
      orderedBlobs.push(record.blob);
    }

    const type = orderedBlobs[0]?.type || 'application/octet-stream';
    // Blob-of-Blobs: stays disk-backed in Safari instead of loading the
    // whole (potentially 500 MB+) audiobook file into memory.
    const assembled = new Blob(orderedBlobs, { type });
    return URL.createObjectURL(assembled);
  } catch {
    return null;
  }
}

export function releaseMediaUrl(url) {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
}

export async function getLocalCoverUrl(bookId) {
  if (!isSupported()) return null;
  try {
    const db = await openDb();
    const record = await getCover(db, bookId);
    if (!record || !record.blob) return null;
    return URL.createObjectURL(record.blob);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Offline library browsing
// ---------------------------------------------------------------------

export async function getOfflineLibrary() {
  if (!isSupported()) return [];
  try {
    const db = await openDb();
    const metas = await getAllMeta(db);
    return metas.filter((m) => m.bytesDone > 0 && m.book).map((m) => m.book);
  } catch {
    return [];
  }
}

export async function findOrphans(currentLibraryIds) {
  if (!isSupported()) return [];
  try {
    const db = await openDb();
    const metas = await getAllMeta(db);
    const downloads = metas.map((m) => ({
      bookId: m.bookId,
      title: m.book?.title || '',
      author: m.book?.author || '',
      bytesTotal: m.bytesTotal || 0
    }));
    return core.findOrphanDownloads(downloads, currentLibraryIds);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// Storage estimate / persistence (navigator.storage is secure-context-only
// and frequently undefined here — feature-detected throughout, never
// assumed present, never thrown from).
// ---------------------------------------------------------------------

export async function getStorageEstimate() {
  const unsupported = { usage: 0, quota: 0, persisted: false, supported: false };
  try {
    if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.estimate !== 'function') {
      return unsupported;
    }
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    let persisted = false;
    if (typeof navigator.storage.persisted === 'function') {
      persisted = await navigator.storage.persisted().catch(() => false);
    }
    return { usage, quota, persisted, supported: true };
  } catch {
    return unsupported;
  }
}

export async function requestPersistence() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.persist !== 'function') {
      return false;
    }
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Position queue (position POSTs made while offline)
// ---------------------------------------------------------------------

export async function queuePosition({ bookId, fileIndex, seconds } = {}) {
  if (!isSupported() || !bookId) return;
  try {
    const db = await openDb();
    await addPositionQueueEntry(db, { bookId, fileIndex, seconds, queuedAt: Date.now() });
  } catch {
    /* best-effort; a dropped queue entry just means one fewer resync point */
  }
}

/**
 * Reads back the newest queued-but-not-yet-flushed position for a book —
 * without this, a user who plays for hours offline, closes the app, and
 * reopens it still offline has no way to recover where they were; the UI
 * would otherwise fall back to the stale position captured at download
 * time and silently lose their progress. Returns null when nothing is
 * queued for this book. Never throws.
 *
 * @param {string} bookId
 * @returns {Promise<{fileIndex:number, seconds:number}|null>}
 */
export async function getQueuedPosition(bookId) {
  if (!isSupported() || !bookId) return null;
  try {
    const db = await openDb();
    const raw = await getAllPositionQueueEntries(db);
    return core.resolveLatestQueuedPosition(raw, bookId);
  } catch {
    return null;
  }
}

/**
 * Retires every queued row for (bookId, fileIndex) — call this after a
 * *direct* position POST succeeds, so a later flushPositionQueue() doesn't
 * replay an older queued value over top of it. Without this: a blip queues
 * seconds:100, the network returns, the user pauses at seconds:3600 and
 * that direct POST succeeds (server now at 3600), then the next flush
 * still replays the stale queued 100 and silently rewinds the server-side
 * position — and since the sync interval only runs during playback, a
 * paused book never self-corrects. Never throws.
 *
 * @param {string} bookId
 * @param {number} fileIndex
 */
export async function dropQueuedPosition(bookId, fileIndex) {
  if (!isSupported() || !bookId || !Number.isFinite(fileIndex)) return;
  try {
    const db = await openDb();
    const raw = await getAllPositionQueueEntries(db);
    const ids = core.queueIdsForKey(raw, bookId, fileIndex);
    await deletePositionQueueEntries(db, ids);
  } catch {
    /* best-effort; never throw out of the public API */
  }
}

/**
 * Replays queued position updates via the injected postFn (e.g. a wrapper
 * around apiPost('/api/position', ...)), collapsing to the newest entry per
 * (bookId, fileIndex) first — see offline-core.js's collapsePositionQueue()
 * for why.
 *
 * postFn's rejection is expected to carry a numeric `.status` when it's an
 * HTTP-level failure (mirroring apiPost()'s `err.status` in app.js) — see
 * offline-core.js's isPermanentQueueFailure()/nextQueueAction() for exactly
 * which statuses are treated as permanent (most 4xx, e.g. 404 for a book
 * whose id regenerated after re-import or 400 for an out-of-range
 * fileIndex) vs. transient-and-retriable despite being 4xx (401 session
 * expired, 408 timeout, 429 rate-limited) vs. a network-level failure with
 * no status at all (still offline) — only the permanent case discards the
 * entry; everything else stops the flush and leaves it queued for later.
 *
 * @param {(entry: {bookId,fileIndex,seconds}) => Promise<any>} postFn
 * @returns {Promise<{flushed:number, remaining:number}>} flushed/remaining
 *   count raw queued rows, not collapsed entries — one replay (successful
 *   or permanently-failed) can retire several superseded raw rows for the
 *   same (bookId,fileIndex).
 */
export async function flushPositionQueue(postFn) {
  if (!isSupported() || typeof postFn !== 'function') return { flushed: 0, remaining: 0 };
  try {
    const db = await openDb();
    const raw = await getAllPositionQueueEntries(db);
    if (raw.length === 0) return { flushed: 0, remaining: 0 };

    const collapsed = core.collapsePositionQueue(raw);
    let flushed = 0;
    for (const entry of collapsed) {
      let err = null;
      try {
        await postFn({ bookId: entry.bookId, fileIndex: entry.fileIndex, seconds: entry.seconds });
      } catch (postErr) {
        err = postErr;
      }
      // The actual decision (commit / discard-as-unpostable / stop-and-retry-
      // later) lives in offline-core.js's nextQueueAction — this loop just
      // applies whatever it says, so the decision logic itself stays
      // unit-testable independent of IndexedDB.
      const action = core.nextQueueAction(err);
      if (action === 'stop') break;
      const ids = core.queueIdsForKey(raw, entry.bookId, entry.fileIndex);
      await deletePositionQueueEntries(db, ids);
      flushed += ids.length;
    }
    const remaining = await countPositionQueueEntries(db);
    return { flushed, remaining };
  } catch {
    return { flushed: 0, remaining: 0 };
  }
}
