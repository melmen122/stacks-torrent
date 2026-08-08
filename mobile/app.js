// stacks — mobile web app.
// Plain vanilla JS, no build step, no dependencies. Talks to the same-origin
// HTTP API served by the Electron app's phone server (see the API contract
// notes throughout). Designed for Safari on iOS/iPadOS, "Add to Home
// Screen" standalone mode.
//
// Loaded as a native ES module (<script type="module">) so this file can
// import formatBytes()/filesToWarm() from offline-core.js — a static
// top-level import, not the dynamic import('./offline.js') used below for
// the offline *engine* itself. offline-core.js is pure planning/formatting
// logic with no browser APIs (unit-tested in node — see
// tests/offlineCore.test.js), so unlike offline.js there's no
// graceful-degradation case to design around here.
import { formatBytes, filesToWarm } from './offline-core.js';

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------
  const els = {
    offlineBanner: document.getElementById('offline-banner'),
    offlineBannerText: document.getElementById('offline-banner-text'),
    offlineRetry: document.getElementById('offline-retry'),

    screens: {
      loading: document.getElementById('screen-loading'),
      pin: document.getElementById('screen-pin'),
      library: document.getElementById('screen-library'),
      player: document.getElementById('screen-player'),
      downloads: document.getElementById('screen-downloads'),
    },

    pinForm: document.getElementById('pin-form'),
    pinInput: document.getElementById('pin-input'),
    pinSubmit: document.getElementById('pin-submit'),
    pinError: document.getElementById('pin-error'),

    refreshLibraryBtn: document.getElementById('btn-refresh-library'),
    librarySearch: document.getElementById('library-search'),
    openDownloadsBtn: document.getElementById('btn-open-downloads'),
    genreFilterRow: document.getElementById('genre-filter-row'),
    continueRow: document.getElementById('continue-listening-row'),
    continueList: document.getElementById('continue-listening-list'),
    allBooksTitle: document.getElementById('all-books-title'),
    libraryGrid: document.getElementById('library-grid'),
    libraryEmpty: document.getElementById('library-empty'),

    downloadsBackBtn: document.getElementById('btn-downloads-back'),
    downloadsStorage: document.getElementById('downloads-storage'),
    persistenceNote: document.getElementById('persistence-note'),
    persistenceNoteText: document.getElementById('persistence-note-text'),
    persistenceNoteDismiss: document.getElementById('persistence-note-dismiss'),
    downloadsList: document.getElementById('downloads-list'),
    downloadsEmpty: document.getElementById('downloads-empty'),
    deleteAllDownloadsBtn: document.getElementById('btn-delete-all-downloads'),
    downloadsOrphansSection: document.getElementById('downloads-orphans-section'),
    downloadsOrphansList: document.getElementById('downloads-orphans-list'),

    downloadBtn: document.getElementById('btn-download'),
    downloadBtnIcon: document.getElementById('download-btn-icon'),
    downloadBtnLabel: document.getElementById('download-btn-label'),
    downloadPanel: document.getElementById('download-panel'),
    downloadPanelBody: document.getElementById('download-panel-body'),

    playerBackBtn: document.getElementById('btn-player-back'),
    playerChaptersBtn: document.getElementById('btn-player-chapters'),
    playerCoverImg: document.getElementById('player-cover-img'),
    playerCoverFallback: document.getElementById('player-cover-fallback'),
    playerTitle: document.getElementById('player-book-title'),
    playerAuthor: document.getElementById('player-book-author'),
    playerFileLabel: document.getElementById('player-file-label'),

    seekBar: document.getElementById('seek-bar'),
    timeElapsed: document.getElementById('time-elapsed'),
    timeRemaining: document.getElementById('time-remaining'),

    back30Btn: document.getElementById('btn-back-30'),
    fwd30Btn: document.getElementById('btn-fwd-30'),
    playPauseBtn: document.getElementById('btn-play-pause'),
    iconPlay: document.getElementById('icon-play'),
    iconPause: document.getElementById('icon-pause'),

    speedBtn: document.getElementById('btn-speed'),
    sleepBtn: document.getElementById('btn-sleep'),
    sleepLabel: document.getElementById('sleep-label'),

    chaptersPanel: document.getElementById('chapters-panel'),
    chaptersList: document.getElementById('chapters-list'),
    speedPanel: document.getElementById('speed-panel'),
    speedOptions: document.getElementById('speed-options'),
    sleepPanel: document.getElementById('sleep-panel'),
    sleepOptions: document.getElementById('sleep-options'),

    audio: document.getElementById('audio'),
  };

  const audio = els.audio;

  // ---------------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------------
  const state = {
    screen: 'loading',
    books: [],
    filterGenre: null,
    searchQuery: '',
    currentBook: null,
    currentFileIndex: 0,
    // True once we've fallen back to offline.getOfflineLibrary() because the
    // server couldn't be reached at all (boot-time, or a mid-session retry).
    // Distinct from the transient `offline-banner` (which just means "the
    // last request failed") — this means "we've given up on the network for
    // now and are driving the library screen from local data instead."
    isOfflineMode: false,
  };

  // ---------------------------------------------------------------------
  // Offline download engine (mobile/offline.js) — optional. Every call site
  // below checks `offlineReady` first so the app behaves exactly as it does
  // today when the module is missing, fails to load, or isSupported() is
  // false (e.g. Safari private mode, or storage APIs unavailable).
  // ---------------------------------------------------------------------
  let offline = null;
  let offlineReady = false;
  let offlineInitStarted = false;
  // bookId -> {status, bytesDone, bytesTotal, error} snapshot from the last
  // listDownloads()/getDownloadState() refresh — drives library badges, the
  // downloads screen, and the player's download pill without re-awaiting the
  // engine on every render.
  let downloadsIndex = {};
  // fileIndex -> local blob/object URL, for the *currently open* book only.
  // Cleared (and every entry released) on book change / player exit.
  let localFileUrlCache = {};
  // The local URL currently assigned to `audio.src`, if any — tracked
  // separately so switching files/books can release exactly the one that was
  // actually in use without guessing from localFileUrlCache.
  let currentLocalUrl = null;
  let flushingPositionQueue = false;
  let activeDownloadBookId = null; // book currently mid-download, for the onProgress handler
  // { bookId, code } | null — the most recent *unsuccessful, non-'complete'*
  // downloadBook() outcome. Needed because the engine only persists status/
  // error to IndexedDB for a handful of cases (e.g. quota/integrity), not
  // for a transient 'network' failure mid-attempt — without tracking it here
  // too, a download that fails because the device is offline would silently
  // revert the sheet to "Download"/"Resume" with no indication anything just
  // went wrong. Cleared on the next attempt for the same book, or on success.
  let lastDownloadError = null;

  let authLost = false;
  let isSeeking = false;
  let pendingResumeSeconds = null;
  // Set when a backward seek crosses into a previous file whose duration
  // isn't known yet (server never sends per-file durations for multi-file
  // books). Resolved against the real `audio.duration` once `loadedmetadata`
  // fires for that file — see seekRelative()/switchToFile().
  let pendingResumeFromEnd = null;
  // True from the moment switchToFile()/enterPlayer() calls audio.load()
  // until loadedmetadata (or error) fires. audio.load() synchronously fires
  // a `pause` event and resets currentTime to 0; while this flag is set the
  // pause handler must not persist that transient state as the real position.
  let isLoadingFile = false;
  // audio.duration for files we've actually loaded for the *current* book,
  // keyed by file index — lets repeated backward crossings into the same
  // file resolve instantly instead of waiting on loadedmetadata again.
  // Cleared in enterPlayer() on every book switch since it's only keyed by
  // index, not book id.
  const fileDurationCache = {};
  let syncIntervalId = null;
  let armedChapterKey = null;
  let sleepEndOfChapter = false;
  let sleepTimeoutId = null;
  let sleepFadeIntervalId = null;
  let chaptersCache = [];
  let chapterItemEls = [];
  let lastActiveChapterIndex = -1;

  const SYNC_INTERVAL_MS = 10000;
  const SLEEP_FADE_MS = 10000;
  const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 1.75, 2];
  const SLEEP_OPTIONS = [15, 30, 45, 60];

  // ---------------------------------------------------------------------
  // Cover placeholder (mirrors the desktop app's utils/color.js so book
  // tiles look consistent whether or not the cover has embedded art)
  // ---------------------------------------------------------------------
  const GRADIENT_PALETTE = [
    ['#f2a541', '#c9722c'],
    ['#5b8def', '#2b4c8c'],
    ['#e85d75', '#a13655'],
    ['#4fb0a5', '#276b63'],
    ['#a875e8', '#5c3a91'],
    ['#e8c93f', '#a68a1f'],
    ['#4f9ce8', '#2a5f9e'],
    ['#e87d4f', '#a3502a'],
  ];
  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i += 1) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }
  function gradientFor(seed) {
    const pair = GRADIENT_PALETTE[hashString(seed || '') % GRADIENT_PALETTE.length];
    return `linear-gradient(155deg, ${pair[0]}, ${pair[1]})`;
  }
  function initialsFor(title) {
    if (!title) return '?';
    const words = title.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function buildCoverEl(book, { withImage = true, withBadge = true } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'book-cover';
    if (withImage && book.hasCover) {
      const img = document.createElement('img');
      img.src = coverUrl(book.id);
      img.alt = '';
      img.loading = 'lazy';
      wrap.appendChild(img);
    } else {
      wrap.style.background = gradientFor(`${book.title}${book.author || ''}`);
      wrap.textContent = initialsFor(book.title);
    }
    if (withBadge && offlineReady) {
      const dl = downloadsIndex[book.id];
      if (dl && dl.status === 'complete') {
        const badge = document.createElement('span');
        badge.className = 'book-download-badge';
        badge.setAttribute('aria-hidden', 'true');
        badge.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>';
        wrap.appendChild(badge);
      } else if (dl && (dl.status === 'downloading' || dl.status === 'partial')) {
        const badge = document.createElement('span');
        badge.className = 'book-download-badge downloading';
        badge.setAttribute('aria-hidden', 'true');
        badge.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v11" /><path d="M7.5 10l4.5 4.5L16.5 10" /></svg>';
        wrap.appendChild(badge);
      }
    }
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Formatting helpers (mirrors utils/format.js)
  // ---------------------------------------------------------------------
  function formatClock(seconds) {
    let total = Number.isFinite(seconds) ? seconds : 0;
    if (total < 0) total = 0;
    total = Math.floor(total);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${m}:${pad(s)}`;
  }

  /** Rough "~30 MB/hour of audio" estimate from known per-file durations
   * (only available when every file's durationSeconds is known — see
   * wireBook() in phoneServer.js, which only reports it for single-file
   * books). Returns null rather than a guess when duration data is missing,
   * so the UI can fall back to an honest generic warning instead of a made
   * up number. */
  function estimateDownloadBytes(book) {
    const files = (book && book.files) || [];
    if (!files.length) return null;
    if (!files.every((f) => f.durationSeconds != null)) return null;
    const totalSeconds = files.reduce((sum, f) => sum + (f.durationSeconds || 0), 0);
    return totalSeconds * ((30 * 1024 * 1024) / 3600);
  }

  // ---------------------------------------------------------------------
  // Chapters (mirrors utils/chapters.js, adapted to the mobile API's field
  // names: startSeconds instead of startSec, files as {index,name,...})
  // ---------------------------------------------------------------------
  function cleanFileName(name) {
    const base = (name || '').split(/[\\/]/).pop() || '';
    const withoutExt = base.replace(/\.[^./\\]+$/, '');
    const stripped = withoutExt
      .replace(/^\s*\d+[\s._-]*/, '')
      .replace(/^[-_\s]+/, '')
      .replace(/[_]+/g, ' ')
      .trim();
    return stripped || withoutExt.trim() || base;
  }

  function getChapters(book) {
    if (!book) return [];
    if (Array.isArray(book.chapters) && book.chapters.length > 0) {
      return book.chapters.map((c, i) => ({
        title: c.title || `Chapter ${i + 1}`,
        fileIndex: c.fileIndex ?? 0,
        startSeconds: c.startSeconds || 0,
      }));
    }
    return (book.files || []).map((f, i) => ({
      title: cleanFileName(f.name) || `Chapter ${i + 1}`,
      fileIndex: f.index ?? i,
      startSeconds: 0,
    }));
  }

  function currentChapterIndex(chapters, fileIndex, currentTime) {
    let active = -1;
    for (let i = 0; i < chapters.length; i += 1) {
      const c = chapters[i];
      if (c.fileIndex < fileIndex) active = i;
      else if (c.fileIndex === fileIndex && c.startSeconds <= currentTime) active = i;
    }
    return active;
  }

  // ---------------------------------------------------------------------
  // URLs
  // ---------------------------------------------------------------------
  function coverUrl(bookId) {
    return `/cover/${encodeURIComponent(bookId)}`;
  }
  function mediaUrl(bookId, fileIndex) {
    return `/media/${encodeURIComponent(bookId)}/${fileIndex}`;
  }

  // ---------------------------------------------------------------------
  // Offline download engine — load + local-URL lifecycle
  // ---------------------------------------------------------------------

  // Dynamic import (not a static top-level `import`) so a missing/broken
  // offline.js degrades to "no offline features" instead of taking the whole
  // app down — every offline call site below is gated on `offlineReady`.
  async function initOfflineEngine() {
    if (offlineInitStarted) return;
    offlineInitStarted = true;
    try {
      const mod = await import('./offline.js');
      if (mod && typeof mod.isSupported === 'function' && mod.isSupported()) {
        await mod.init();
        offline = mod;
        offlineReady = true;
      }
    } catch {
      offline = null;
      offlineReady = false;
    }
    els.openDownloadsBtn.hidden = !offlineReady;
    els.downloadBtn.hidden = !offlineReady;
    if (offlineReady) refreshDownloadsIndex();
  }

  async function refreshDownloadsIndex() {
    if (!offlineReady) return;
    try {
      const list = await offline.listDownloads();
      const next = {};
      (list || []).forEach((d) => { next[d.bookId] = d; });
      downloadsIndex = next;
    } catch {
      /* keep the last known snapshot rather than blanking it on a transient error */
    }
  }

  /** Mirrors the server's authoritative position onto every downloaded
   * book's offline copy after a library refresh, so a book that was only
   * ever advanced by a *different* device (never persisted from this one,
   * so persistPosition()'s own updateStoredPosition() call never ran for
   * it) doesn't stay frozen at whatever position it had at download time.
   * Safe even if this races ahead of a not-yet-flushed local queue entry —
   * enterPlayer() always prefers getQueuedPosition() over book.position
   * when one exists, so a queued (newer) position can never be shadowed by
   * this. */
  function syncStoredPositionsFromLibrary(books) {
    if (!offlineReady || typeof offline.updateStoredPosition !== 'function') return;
    (books || []).forEach((b) => {
      if (!b || !b.id || !downloadsIndex[b.id] || !b.position) return;
      offline.updateStoredPosition(b.id, {
        fileIndex: b.position.fileIndex || 0,
        seconds: b.position.seconds || 0,
      }).catch(() => {});
    });
  }

  /** Releases exactly the local URL currently assigned to audio.src (if any)
   * and evicts any cache entries pointing at it, so a later switch back to
   * the same file index re-resolves a fresh (non-revoked) URL instead of
   * reusing a dead one. Safe to call unconditionally. */
  function releaseCurrentLocalUrl() {
    if (currentLocalUrl && offlineReady) {
      try { offline.releaseMediaUrl(currentLocalUrl); } catch { /* best effort */ }
      Object.keys(localFileUrlCache).forEach((key) => {
        if (localFileUrlCache[key] === currentLocalUrl) delete localFileUrlCache[key];
      });
    }
    currentLocalUrl = null;
  }

  /** Full teardown on book change: releases every cached local URL for the
   * book that's being left, not just the one currently playing (a
   * background prefetch — see prefetchLocalFileInBackground — can leave an
   * unused-but-resolved entry in the cache). */
  function releasePlayerLocalUrls() {
    if (offlineReady) {
      Object.values(localFileUrlCache).forEach((url) => {
        try { offline.releaseMediaUrl(url); } catch { /* best effort */ }
      });
    }
    localFileUrlCache = {};
    currentLocalUrl = null;
  }

  /** Player-exit (back button) cleanup: releases every *prefetched-but-not-
   * playing* local URL, but deliberately leaves `currentLocalUrl` (the one
   * actually assigned to audio.src) alone. Tapping back doesn't stop
   * playback — it keeps going via mediaSession while the user browses the
   * library — so revoking the URL the audio element is actively using here
   * risks silently killing background playback (behavior varies by
   * browser/iOS version). That URL gets released for real on the next
   * enterPlayer() call (book change or reopening the same book) or,
   * failing that, whenever the page itself is torn down (browsers revoke
   * all a document's object URLs on unload regardless). */
  function releaseUnusedLocalUrls() {
    if (offlineReady) {
      Object.entries(localFileUrlCache).forEach(([key, url]) => {
        if (url === currentLocalUrl) return;
        try { offline.releaseMediaUrl(url); } catch { /* best effort */ }
        delete localFileUrlCache[key];
      });
    }
  }

  /** Best-effort, fire-and-forget: warms localFileUrlCache for `fileIndex` so
   * a *future* switchToFile() to it can resolve synchronously from cache
   * instead of streaming. Never affects what's currently playing — resolving
   * here doesn't touch audio.src. Guards against the book/file having moved
   * on by the time it resolves (revoking rather than caching a now-stale URL). */
  function prefetchLocalFileInBackground(bookId, fileIndex) {
    if (!offlineReady || localFileUrlCache[fileIndex] != null) return;
    offline.getLocalMediaUrl(bookId, fileIndex).then((url) => {
      if (!url) return;
      const stillRelevant = state.currentBook && state.currentBook.id === bookId;
      if (stillRelevant && localFileUrlCache[fileIndex] == null) {
        localFileUrlCache[fileIndex] = url;
      } else {
        try { offline.releaseMediaUrl(url); } catch { /* best effort */ }
      }
    }).catch(() => {});
  }

  /** Proactively warms local URLs around `index` so a downloaded book plays
   * start to finish with the network off — including jumps of more than one
   * file away (the chapters panel lets a user jump anywhere; when
   * book.chapters is absent, getChapters() derives one chapter per file, so
   * the chapter list *is* the file list — a jump to chapter 6 is a jump to
   * file 5, not file 1). Without this, switchToFile() only ever found a
   * cache hit *after* a transition had already failed once and streamed as
   * a fallback — no good on a plane, where that fallback stream has nothing
   * to fetch from.
   *
   * Delegates the actual reach to offline-core.js's filesToWarm() (pure,
   * unit-tested) rather than open-coding it here: a *fully* downloaded book
   * warms every file — getLocalMediaUrl() only touches IndexedDB and the
   * assembled Blob-of-Blobs stays disk-backed, so N object URLs is cheap,
   * and releasePlayerLocalUrls()/releaseUnusedLocalUrls() already clean up
   * all of them regardless of how many are cached — while a still-partial
   * download only warms the immediate neighbors, since that's the most
   * likely to actually be available locally yet. Cache hits (see
   * prefetchLocalFileInBackground()) make repeated calls for an
   * already-fully-warmed book cheap no-ops, so this can be (and is) called
   * again on every `loadedmetadata`, not just once from enterPlayer(). */
  function prefetchNeighbors(bookId, index) {
    if (!offlineReady || !state.currentBook || state.currentBook.id !== bookId) return;
    const files = state.currentBook.files || [];
    const dl = downloadsIndex[bookId];
    const isComplete = !!dl && dl.status === 'complete';
    filesToWarm(index, files.length, isComplete).forEach((i) => prefetchLocalFileInBackground(bookId, i));
  }

  // ---------------------------------------------------------------------
  // Connectivity / API
  // ---------------------------------------------------------------------
  function setOffline(isOffline) {
    els.offlineBanner.hidden = !isOffline;
    // Deliberately does NOT trigger flushPositionQueue() here — this runs
    // inside *every* apiGet/apiPost, including the position POST that
    // persistPosition() itself just made. Triggering a flush from a
    // position-POST's own success (before persistPosition()'s success
    // handler even runs — see there) raced a *stale* queued entry for the
    // same (book, file) against the *fresher* value that was just confirmed,
    // and could let the stale one land second and rewind the server. Flush
    // is instead triggered only from signals that are independent of any
    // single position write: loadLibrary() success, the `online` event, and
    // app foreground (see their call sites below).
  }

  function onUnauthorized() {
    if (authLost) return;
    authLost = true;
    pausePlayback();
    stopSyncInterval();
    showScreen('pin');
    setPinError('Your session ended — enter the code again.');
  }

  async function apiGet(path) {
    let res;
    try {
      res = await fetch(path, { credentials: 'same-origin' });
    } catch (err) {
      setOffline(true);
      throw err;
    }
    setOffline(false);
    if (res.status === 401) {
      onUnauthorized();
      const err = new Error('unauthorized');
      err.status = 401;
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'request_failed');
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async function apiPost(path, body, { silentAuth = false, signal } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      setOffline(true);
      throw err;
    }
    setOffline(false);
    if (res.status === 401 && !silentAuth) {
      onUnauthorized();
    }
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'request_failed');
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------------
  // Position-write serialization
  // ---------------------------------------------------------------------
  // A direct write from persistPosition() and a replay from
  // flushPositionQueue() are triggered independently (one from playback
  // events, the other from reconnect/foreground/online signals) and both
  // hit the same /api/position endpoint — nothing otherwise stops their
  // network requests from being in flight at once and resolving in the
  // *wrong* order (a stale replay's response landing after a fresher direct
  // write's), which would silently rewind the server to an older position.
  // Routing every write through this single chain makes ordering
  // deterministic: exactly one /api/position request is ever in flight, in
  // true call order, regardless of which trigger issued it or which
  // network response would otherwise have arrived first. (A server-side
  // monotonic guard can't substitute for this — rewinding to an earlier
  // chapter is a legitimate, *smaller* position that must be allowed to
  // overwrite a larger one; only call order, not value order, tells stale
  // apart from deliberate.)
  let positionWriteChain = Promise.resolve();

  /** Runs `writeFn` only after every previously-enqueued write has settled,
   * and returns a promise reflecting *this* write's own outcome (unlike the
   * shared chain variable itself, which is always normalized back to a
   * resolved promise below so one failed write can't jam every write queued
   * after it). Doesn't retain `writeFn`/its payload beyond the closure the
   * caller already holds — the chain itself carries no book/payload state,
   * just a settled-or-not signal, so it can't grow unbounded or leak old
   * books across calls. */
  function enqueuePositionWrite(writeFn) {
    const resultPromise = positionWriteChain.then(writeFn);
    positionWriteChain = resultPromise.then(() => undefined, () => undefined);
    return resultPromise;
  }

  // The phone server is a plain-HTTP LAN/Tailscale address — walking out of
  // wifi range mid-POST leaves the TCP connection black-holed (no RST),
  // and iOS can sit on a socket like that for minutes with no error and no
  // timeout of its own. Every write now funnels through the single
  // positionWriteChain above, so a stalled fetch with no bound on it would
  // stall *every* later position write behind it — including queuing them
  // to IndexedDB, since queuePosition() only ever runs from persistPosition()'s
  // `.catch`, which can't fire until the fetch actually settles one way or
  // the other. An explicit abort bounds that stall to ~9s: AbortController
  // + setTimeout rather than AbortSignal.timeout() (Safari 16+ only, and
  // this app deliberately doesn't assume a recent Safari). The resulting
  // AbortError carries no `.status`, so it falls straight through
  // apiPost()'s existing network-failure path into queuePosition() exactly
  // like any other offline failure.
  const POSITION_WRITE_TIMEOUT_MS = 9000;
  function postPositionWithTimeout(payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), POSITION_WRITE_TIMEOUT_MS);
    return apiPost('/api/position', payload, { signal: controller.signal })
      .finally(() => clearTimeout(timeoutId));
  }

  /** Drains offline.js's queued-while-disconnected positions against the
   * real API. Safe to call speculatively/often — a no-op guard against
   * concurrent runs, and the engine itself is the source of truth for what's
   * left to send (queuePosition() during persistPosition() is what fills it;
   * see persistPosition() below).
   *
   * The postFn wrapper deliberately just awaits the (serialized) write and
   * lets a rejection propagate unmodified — offline.js's flushPositionQueue()
   * branches on the rejection's `.status` (a [400,500) status is permanent,
   * discard and continue; anything else, including a missing `.status` for
   * a network-level failure, means "still offline," stop and retry later),
   * and apiPost() already attaches `.status` from the response on any
   * non-2xx. Catching/re-wrapping it here would drop that and risk a
   * permanently-404ing entry blocking the whole queue forever. */
  async function flushPositionQueue() {
    if (!offlineReady || flushingPositionQueue) return;
    flushingPositionQueue = true;
    try {
      await offline.flushPositionQueue(async (payload) => {
        await enqueuePositionWrite(() => postPositionWithTimeout(payload));
        // Mirrors each successfully-replayed entry onto the book's offline
        // copy, same as the direct-write path in persistPosition() — covers
        // "listened offline, reconnected and flushed, then went offline
        // again before any further direct write," which would otherwise
        // leave the stored position frozen at whatever it was before this
        // flush ran.
        if (typeof offline.updateStoredPosition === 'function') {
          offline.updateStoredPosition(payload.bookId, {
            fileIndex: payload.fileIndex,
            seconds: payload.seconds,
          }).catch(() => {});
        }
      });
    } catch {
      /* best effort — whatever's left stays queued for the next trigger */
    } finally {
      flushingPositionQueue = false;
    }
  }

  function retryConnection() {
    if (state.isOfflineMode) {
      // We've fallen all the way back to the offline library — re-run the
      // full boot sequence rather than just loadLibrary(), since we may not
      // even know whether the PIN session is still valid.
      boot();
      return;
    }
    if (state.screen === 'library') loadLibrary();
    else if (state.screen === 'player') {
      // Route through switchToFile() rather than a bare audio.load() — a
      // raw load() here bypasses the whole isLoadingFile/pendingResumeSeconds
      // mechanism (nothing sets isLoadingFile, nothing tells loadedmetadata
      // where to resume), so the synchronous pause it fires would persist
      // seconds: 0 and the reload would restore nothing, losing the user's
      // place on every "network blip → tap Retry".
      //
      // If the connection dropped *before* loadedmetadata ever fired (e.g.
      // right after enterPlayer() or a chapter jump, mid-load rather than
      // mid-playback), audio.currentTime is still 0/stale — the real
      // intended position lives in pendingResumeSeconds/pendingResumeFromEnd
      // instead, so prefer those. `??` (not `||`) because 0 is a legitimate
      // resume position, not "unknown".
      if (state.currentBook) {
        try {
          if (pendingResumeFromEnd != null) {
            switchToFile(state.currentFileIndex, null, {
              autoplay: !audio.paused,
              secondsFromEnd: pendingResumeFromEnd,
            });
          } else {
            const resumeSeconds = pendingResumeSeconds ?? audio.currentTime ?? 0;
            switchToFile(state.currentFileIndex, resumeSeconds, { autoplay: !audio.paused });
          }
        } catch { /* ignore */ }
      }
    } else {
      boot();
    }
  }

  // ---------------------------------------------------------------------
  // Screen management
  // ---------------------------------------------------------------------
  function showScreen(name) {
    state.screen = name;
    Object.entries(els.screens).forEach(([key, el]) => {
      el.hidden = key !== name;
    });
  }

  // ---------------------------------------------------------------------
  // PIN screen
  // ---------------------------------------------------------------------
  let throttleIntervalId = null;

  function setPinError(message) {
    if (!message) {
      els.pinError.hidden = true;
      els.pinError.textContent = '';
      return;
    }
    els.pinError.hidden = false;
    els.pinError.textContent = message;
  }

  function startThrottleCountdown(seconds) {
    let remaining = Math.max(1, Math.ceil(seconds));
    if (throttleIntervalId) clearInterval(throttleIntervalId);
    els.pinSubmit.disabled = true;
    const tick = () => {
      setPinError(`Too many attempts — try again in ${remaining}s.`);
      if (remaining <= 0) {
        clearInterval(throttleIntervalId);
        throttleIntervalId = null;
        els.pinSubmit.disabled = false;
        setPinError('');
        return;
      }
      remaining -= 1;
    };
    tick();
    throttleIntervalId = setInterval(tick, 1000);
  }

  els.pinInput.addEventListener('input', () => {
    const digitsOnly = els.pinInput.value.replace(/[^0-9]/g, '');
    if (digitsOnly !== els.pinInput.value) els.pinInput.value = digitsOnly;
    if (digitsOnly.length === 6 && !els.pinSubmit.disabled) {
      els.pinForm.requestSubmit();
    }
  });

  els.pinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = els.pinInput.value.trim();
    if (!pin || els.pinSubmit.disabled) return;
    setPinError('');
    els.pinSubmit.disabled = true;
    try {
      const data = await apiPost('/api/auth', { pin }, { silentAuth: true });
      if (data && data.ok) {
        authLost = false;
        els.pinInput.value = '';
        await enterLibrary();
      }
    } catch (err) {
      if (err.status === 429) {
        const retryMs = (err.body && err.body.retryAfterMs) || 1000;
        startThrottleCountdown(retryMs / 1000);
      } else if (err.status === 401) {
        setPinError('Incorrect code — try again.');
      } else {
        setPinError("Couldn't reach stacks. Check your connection and try again.");
      }
    } finally {
      if (!throttleIntervalId) els.pinSubmit.disabled = false;
    }
  });

  // ---------------------------------------------------------------------
  // Library screen
  // ---------------------------------------------------------------------
  function hasProgress(book) {
    const p = book.position;
    return !!p && ((p.seconds || 0) > 0 || (p.fileIndex || 0) > 0);
  }

  function uniqueGenres(books) {
    const set = new Set();
    books.forEach((b) => (b.genres || []).forEach((g) => set.add(g)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  function renderGenreFilters() {
    const genres = uniqueGenres(state.books);
    els.genreFilterRow.hidden = genres.length === 0;
    els.genreFilterRow.innerHTML = '';
    if (genres.length === 0) return;

    const makeChip = (label, value) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'genre-chip' + (state.filterGenre === value ? ' active' : '');
      btn.textContent = label;
      btn.setAttribute('aria-pressed', String(state.filterGenre === value));
      btn.addEventListener('click', () => {
        state.filterGenre = value;
        renderLibrary();
      });
      return btn;
    };

    els.genreFilterRow.appendChild(makeChip('All', null));
    genres.forEach((g) => els.genreFilterRow.appendChild(makeChip(g, g)));
  }

  function filteredSortedBooks() {
    const q = state.searchQuery.trim().toLowerCase();
    return state.books
      .filter((b) => !state.filterGenre || (b.genres || []).includes(state.filterGenre))
      .filter((b) => {
        if (!q) return true;
        return (b.title || '').toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q);
      })
      .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }

  function buildBookTile(book) {
    const dl = downloadsIndex[book.id];
    const isDownloaded = !!dl && dl.status === 'complete';
    // Offline mode: books we don't have locally can't be opened at all (no
    // server to fetch them from), so they're rendered as inert/dimmed rather
    // than a tappable button — "visibly unavailable", not hidden.
    const unavailable = state.isOfflineMode && !isDownloaded;

    const btn = document.createElement(unavailable ? 'div' : 'button');
    if (!unavailable) btn.type = 'button';
    btn.className = 'book-tile' + (unavailable ? ' book-tile-unavailable' : '');
    btn.appendChild(buildCoverEl(book));

    const title = document.createElement('span');
    title.className = 'book-tile-title';
    title.textContent = book.title;
    btn.appendChild(title);

    const author = document.createElement('span');
    author.className = 'book-tile-author';
    author.textContent = book.author || '';
    btn.appendChild(author);

    if (unavailable) {
      const status = document.createElement('span');
      status.className = 'book-tile-status';
      status.textContent = 'Not downloaded';
      btn.appendChild(status);
    } else {
      btn.addEventListener('click', () => openBook(book.id));
    }
    return btn;
  }

  function buildContinueCard(book) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'book-tile continue-card';
    btn.appendChild(buildCoverEl(book));

    const title = document.createElement('span');
    title.className = 'book-tile-title';
    title.textContent = book.title;
    btn.appendChild(title);

    const track = document.createElement('div');
    track.className = 'continue-progress';
    const fill = document.createElement('div');
    fill.className = 'continue-progress-fill';
    const totalKnown = (book.files || []).every((f) => f.durationSeconds != null);
    if (totalKnown && book.files.length) {
      const totalSeconds = book.files.reduce((sum, f) => sum + (f.durationSeconds || 0), 0);
      const elapsed = book.files
        .slice(0, book.position.fileIndex || 0)
        .reduce((sum, f) => sum + (f.durationSeconds || 0), 0) + (book.position.seconds || 0);
      fill.style.width = `${Math.min(100, Math.max(2, (elapsed / Math.max(1, totalSeconds)) * 100))}%`;
    } else {
      fill.style.width = '8%';
    }
    track.appendChild(fill);
    btn.appendChild(track);

    btn.addEventListener('click', () => openBook(book.id));
    return btn;
  }

  function renderLibrary() {
    renderGenreFilters();

    // In offline mode, "Continue listening" only makes sense for books we
    // can actually open — the main grid below still shows every book (dimmed
    // if unavailable) but this shortcut row would be misleading if it linked
    // to unplayable ones.
    const continuing = state.books
      .filter(hasProgress)
      .filter((b) => !state.isOfflineMode || (downloadsIndex[b.id] && downloadsIndex[b.id].status === 'complete'));
    els.continueRow.hidden = continuing.length === 0;
    els.continueList.innerHTML = '';
    continuing.forEach((b) => els.continueList.appendChild(buildContinueCard(b)));

    els.allBooksTitle.textContent = state.filterGenre || 'All books';

    const list = filteredSortedBooks();
    els.libraryGrid.innerHTML = '';
    list.forEach((b) => els.libraryGrid.appendChild(buildBookTile(b)));

    if (list.length === 0) {
      els.libraryEmpty.hidden = false;
      els.libraryEmpty.textContent = state.books.length === 0
        ? 'Your library is empty — add books from the desktop app.'
        : 'No books match your search or filter.';
    } else {
      els.libraryEmpty.hidden = true;
    }
  }

  async function loadLibrary() {
    try {
      const data = await apiGet('/api/library');
      state.isOfflineMode = false;
      resetOfflineBannerText();
      state.books = (data && data.books) || [];
      if (offlineReady) {
        await refreshDownloadsIndex();
        syncStoredPositionsFromLibrary(state.books);
      }
      renderLibrary();
      // A full library fetch just round-tripped successfully — an
      // independent-of-any-single-position-write signal that connectivity
      // is back (see setOffline()'s comment for why it doesn't trigger this
      // itself), so this is as good a moment as any to drain anything
      // queued while we were offline.
      flushPositionQueue();
    } catch (err) {
      // apiGet already surfaced the offline banner / auth redirect as needed.
      // A total network failure (not a 401/404/etc — apiGet only throws a
      // plain Error with no .status for that) is the boot-time "open the app
      // on a plane" case — fall back to whatever's downloaded instead of
      // leaving the screen stuck on stale or empty data.
      if (err.status == null && offlineReady && !state.isOfflineMode) {
        await enterOfflineLibrary();
      }
    }
  }

  async function enterLibrary() {
    showScreen('library');
    await loadLibrary();
  }

  function resetOfflineBannerText() {
    els.offlineBannerText.textContent = "Can’t reach stacks. Check that your PC is on and you’re on the same network (or connected via Tailscale).";
  }

  /** Boot-time (or mid-session retry) fallback for "the server is
   * unreachable at all" — drives the library screen from offline.js's own
   * cached data instead of leaving the user stuck on the PIN/loading screen
   * or a stale grid. Downloaded books stay fully playable; everything else
   * is shown but visibly disabled (see buildBookTile). */
  async function enterOfflineLibrary() {
    if (!offlineReady) return;
    state.isOfflineMode = true;
    els.offlineBannerText.textContent = "You’re offline — showing your downloaded books. Other books need a connection to stacks.";
    try {
      const [offlineBooks] = await Promise.all([
        offline.getOfflineLibrary().catch(() => []),
        refreshDownloadsIndex(),
      ]);
      state.books = offlineBooks || [];
    } catch {
      state.books = [];
    }
    showScreen('library');
    renderLibrary();
  }

  els.refreshLibraryBtn.addEventListener('click', loadLibrary);
  els.librarySearch.addEventListener('input', () => {
    state.searchQuery = els.librarySearch.value;
    renderLibrary();
  });
  els.offlineRetry.addEventListener('click', retryConnection);

  async function openBook(id) {
    if (state.isOfflineMode) {
      const book = state.books.find((b) => b.id === id);
      const dl = downloadsIndex[id];
      if (book && dl && dl.status === 'complete') await enterPlayer(book);
      return;
    }
    try {
      const book = await apiGet(`/api/books/${encodeURIComponent(id)}`);
      await enterPlayer(book);
    } catch (err) {
      if (err.status === 404) {
        // Book disappeared from the library (removed on desktop) — refresh.
        loadLibrary();
        return;
      }
      // Network dropped mid-session (not a 404/401 — those already returned
      // above/were handled by apiGet). If this specific book is fully
      // downloaded, fall back to local playback instead of stranding the
      // user on the library screen.
      const dl = downloadsIndex[id];
      if (err.status == null && offlineReady && dl && dl.status === 'complete') {
        try {
          const offlineBooks = await offline.getOfflineLibrary();
          const localBook = (offlineBooks || []).find((b) => b.id === id);
          if (localBook) await enterPlayer(localBook);
        } catch { /* give up silently — offline banner is already showing */ }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Player screen
  // ---------------------------------------------------------------------
  function stopSyncInterval() {
    if (syncIntervalId) {
      clearInterval(syncIntervalId);
      syncIntervalId = null;
    }
  }
  function startSyncInterval() {
    stopSyncInterval();
    syncIntervalId = setInterval(() => persistPosition(), SYNC_INTERVAL_MS);
  }

  function persistPosition(secondsOverride) {
    if (!state.currentBook) return;
    const seconds = secondsOverride != null ? secondsOverride : (audio.currentTime || 0);
    const bookId = state.currentBook.id;
    const fileIndex = state.currentFileIndex;
    const payload = { bookId, fileIndex, seconds };
    // Serialized with flushPositionQueue()'s replays through the same
    // chain (see enqueuePositionWrite()) — this is what actually prevents a
    // stale queued position from landing on the server *after* a fresher
    // direct write, regardless of which trigger fired first. The write
    // itself is time-bounded (postPositionWithTimeout()) so a black-holed
    // socket can't stall this chain — and therefore every later
    // persistPosition() call, including its fallback queuePosition() below
    // — indefinitely.
    enqueuePositionWrite(() => postPositionWithTimeout(payload))
      .then(() => {
        if (!offlineReady) return;
        // This direct write just confirmed a position newer than anything
        // still sitting in the local queue for this exact (book, file) pair
        // — drop it now, before any later-enqueued flush replay gets a
        // chance to land a stale value on top of what the server just
        // accepted.
        if (typeof offline.dropQueuedPosition === 'function') {
          offline.dropQueuedPosition(bookId, fileIndex).catch(() => {});
        }
        // Mirror it onto the book's offline copy too, so a downloaded
        // book's stored position tracks reality instead of staying frozen
        // at whatever it was when the download happened — otherwise
        // reopening the app fully offline after wifi-only listening would
        // resume at 0:00 (see getQueuedPosition()'s use in enterPlayer(),
        // which only ever helps for positions that hit the *failure* path).
        if (typeof offline.updateStoredPosition === 'function') {
          offline.updateStoredPosition(bookId, { fileIndex, seconds }).catch(() => {});
        }
      })
      .catch(() => {
        // Couldn't reach the server (network down, e.g. mid-flight) — stash
        // it so a flush (on reconnect/foreground/online, see
        // flushPositionQueue()) can replay it later instead of silently
        // losing the user's place.
        if (offlineReady) offline.queuePosition(payload).catch(() => {});
      });
  }

  function persistPositionBeacon() {
    if (!state.currentBook || !navigator.sendBeacon) return;
    // A file load is in flight: audio.currentTime is transiently 0/stale
    // here. switchToFile() already persisted the correct resume position
    // synchronously (or, for a cross-file backward seek via secondsFromEnd,
    // hasn't resolved one yet) — beaconing now would race and clobber it
    // with the wrong value, so skip rather than send a bad position.
    if (isLoadingFile) return;
    const payload = JSON.stringify({
      bookId: state.currentBook.id,
      fileIndex: state.currentFileIndex,
      seconds: audio.currentTime || 0,
    });
    try {
      navigator.sendBeacon('/api/position', new Blob([payload], { type: 'application/json' }));
    } catch { /* best effort */ }
  }

  function pausePlayback() {
    try { audio.pause(); } catch { /* ignore */ }
  }

  function getFileDuration(index) {
    if (fileDurationCache[index] != null) return fileDurationCache[index];
    const f = state.currentBook && state.currentBook.files && state.currentBook.files[index];
    return f && f.durationSeconds != null ? f.durationSeconds : null;
  }

  function updateFileLabel() {
    const files = (state.currentBook && state.currentBook.files) || [];
    els.playerFileLabel.textContent = files.length > 1
      ? `File ${state.currentFileIndex + 1} of ${files.length}`
      : '';
  }

  function renderPlayerMeta(book) {
    els.playerTitle.textContent = book.title;
    els.playerAuthor.textContent = book.author || '';
    document.title = `${book.title} — stacks`;

    els.playerCoverImg.hidden = true;
    els.playerCoverFallback.hidden = true;
    if (book.hasCover) {
      els.playerCoverImg.src = coverUrl(book.id);
      els.playerCoverImg.alt = `${book.title} cover`;
      els.playerCoverImg.hidden = false;
    } else {
      els.playerCoverFallback.style.background = gradientFor(`${book.title}${book.author || ''}`);
      els.playerCoverFallback.textContent = initialsFor(book.title);
      els.playerCoverFallback.hidden = false;
    }
  }

  function renderChapters() {
    chaptersCache = getChapters(state.currentBook);
    els.chaptersList.innerHTML = '';
    chapterItemEls = [];
    chaptersCache.forEach((c, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chapter-item';
      btn.dataset.index = String(i);

      const title = document.createElement('span');
      title.textContent = c.title;
      btn.appendChild(title);

      const time = document.createElement('span');
      time.className = 'chapter-item-time';
      time.textContent = formatClock(c.startSeconds);
      btn.appendChild(time);

      btn.addEventListener('click', () => jumpToChapter(c));
      li.appendChild(btn);
      els.chaptersList.appendChild(li);
      chapterItemEls.push(btn);
    });
    lastActiveChapterIndex = -1;
    updateActiveChapterUI();
  }

  // Runs on every `timeupdate` (~4x/sec), so this must stay cheap: reuse the
  // chapter list built by renderChapters() instead of rebuilding it and
  // re-querying the DOM every tick, and only touch the DOM when the active
  // chapter actually changes.
  function updateActiveChapterUI() {
    const activeIndex = currentChapterIndex(chaptersCache, state.currentFileIndex, audio.currentTime || 0);
    if (activeIndex !== lastActiveChapterIndex) {
      if (lastActiveChapterIndex >= 0 && chapterItemEls[lastActiveChapterIndex]) {
        chapterItemEls[lastActiveChapterIndex].classList.remove('active');
      }
      if (activeIndex >= 0 && chapterItemEls[activeIndex]) {
        chapterItemEls[activeIndex].classList.add('active');
      }
      lastActiveChapterIndex = activeIndex;
    }

    if (sleepEndOfChapter) {
      const key = `${state.currentFileIndex}:${activeIndex}`;
      if (armedChapterKey && key !== armedChapterKey) {
        fadeOutAndPause();
        sleepEndOfChapter = false;
        armedChapterKey = null;
        els.sleepLabel.textContent = 'Sleep';
      }
    }
  }

  function getDuration() {
    if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    return getFileDuration(state.currentFileIndex);
  }

  function updateTimeLabels(current, dur) {
    els.timeElapsed.textContent = formatClock(current);
    els.timeRemaining.textContent = dur != null ? `−${formatClock(Math.max(0, dur - current))}` : '−–';
  }

  function updateSeekUI() {
    if (isSeeking) return;
    const dur = getDuration();
    if (dur) {
      els.seekBar.value = String(Math.round(((audio.currentTime || 0) / dur) * 1000));
    }
    updateTimeLabels(audio.currentTime || 0, dur);
  }

  function updateMediaSessionPositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const dur = getDuration();
    if (!dur || !Number.isFinite(dur)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: dur,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.currentTime || 0, dur),
      });
    } catch { /* not fatal */ }
  }

  function setPlayIcon(playing) {
    els.iconPlay.hidden = playing;
    els.iconPause.hidden = !playing;
    els.playPauseBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  // `secondsFromEnd`: used when jumping to a *previous* file whose duration
  // isn't known yet (see seekRelative) — resolved against the real
  // audio.duration once loadedmetadata fires, instead of an exact seconds
  // value we don't have yet.
  // Local-first playback: prefers a downloaded copy over the network stream
  // whenever one is already resolved in localFileUrlCache. This function
  // itself stays fully synchronous (it's called directly from tap handlers
  // — chapter jumps, ±30s crossing a file boundary, prev/next track — with
  // autoplay, and audio.play() has to fire in that same tick or iOS treats
  // it as not user-initiated and blocks it). It never awaits the engine
  // itself; see enterPlayer() for where local URLs actually get resolved
  // ahead of time, and prefetchLocalFileInBackground() for the fallback path
  // when a file wasn't prefetched (streams once, warms the cache for next time).
  function switchToFile(index, seconds, { autoplay = false, secondsFromEnd = null } = {}) {
    const departingIndex = state.currentFileIndex;
    state.currentFileIndex = index;
    isLoadingFile = true;
    if (secondsFromEnd != null) {
      pendingResumeSeconds = null;
      pendingResumeFromEnd = secondsFromEnd;
    } else {
      pendingResumeSeconds = seconds || 0;
      pendingResumeFromEnd = null;
    }

    const bookId = state.currentBook.id;
    const cachedLocal = localFileUrlCache[index];
    // Only release the *previous* file's local URL when we're actually
    // moving away from it. `cachedLocal === currentLocalUrl` happens when
    // switchToFile() is called again for the file that's already loaded
    // (e.g. retryConnection() re-running switchToFile(state.currentFileIndex,
    // …) after a network blip) — releasing there would revoke the exact
    // blob: URL we're about to reassign to audio.src two lines down, leaving
    // playback dead until the player is closed and reopened.
    if (cachedLocal !== currentLocalUrl) {
      releaseCurrentLocalUrl();
    }
    if (cachedLocal) {
      audio.src = cachedLocal;
      currentLocalUrl = cachedLocal;
      // releaseCurrentLocalUrl() (above) evicts localFileUrlCache entries
      // matching the *old* currentLocalUrl, not this one — but re-assert it
      // here regardless so releaseUnusedLocalUrls()/prefetch guards can
      // still see it (it's a no-op when nothing was evicted).
      localFileUrlCache[index] = cachedLocal;
      // We're moving between two already-cached files (the common case for
      // a downloaded book) — releaseCurrentLocalUrl() just evicted the
      // departing index's cache entry along with revoking its URL, so
      // there's a narrow window (until the next loadedmetadata's
      // prefetchNeighbors() call) where switching straight back to it would
      // find a cache miss and fall back to a network fetch that has nothing
      // to reach while offline. Re-queuing it immediately here — fire and
      // forget, same as the streaming branch below — closes that window
      // instead of waiting for the reactive re-warm.
      if (departingIndex !== index) prefetchLocalFileInBackground(bookId, departingIndex);
    } else {
      audio.src = mediaUrl(bookId, index);
      currentLocalUrl = null;
      prefetchLocalFileInBackground(bookId, index);
    }
    audio.load();
    updateFileLabel();
    if (secondsFromEnd == null) {
      // The intended resume position is already known — persist it now so a
      // dropped connection before loadedmetadata still resumes correctly
      // (audio.load() resets currentTime to 0, so we can't read it back off
      // the element here).
      persistPosition(seconds || 0);
    }
    // else: exact seconds aren't known until loadedmetadata resolves the
    // offset against this file's real duration — persisted there instead.
    if (autoplay) {
      audio.play().catch(() => { /* ignore — will require a fresh tap if blocked */ });
    }
  }

  function jumpToChapter(chapter) {
    const targetFileIndex = chapter.fileIndex ?? 0;
    if (targetFileIndex !== state.currentFileIndex) {
      switchToFile(targetFileIndex, chapter.startSeconds, { autoplay: !audio.paused });
    } else {
      audio.currentTime = chapter.startSeconds;
      persistPosition();
      updateActiveChapterUI();
    }
    closeSheet(els.chaptersPanel);
  }

  function seekRelative(deltaSeconds) {
    if (!state.currentBook) return;
    let target = (audio.currentTime || 0) + deltaSeconds;

    if (target < 0) {
      if (state.currentFileIndex > 0) {
        const prevIndex = state.currentFileIndex - 1;
        const prevDuration = getFileDuration(prevIndex);
        if (prevDuration != null) {
          switchToFile(prevIndex, Math.max(0, prevDuration + target), { autoplay: !audio.paused });
        } else {
          // Server doesn't know this file's duration (only file 0 of a
          // single-file book gets one) and we haven't loaded it this session
          // yet — resolve the resume position against the real duration once
          // loadedmetadata fires instead of restarting at 0:00.
          switchToFile(prevIndex, null, { autoplay: !audio.paused, secondsFromEnd: -target });
        }
        return;
      }
      target = 0;
    }

    const dur = getDuration();
    if (dur != null && target > dur) {
      const files = state.currentBook.files || [];
      if (state.currentFileIndex < files.length - 1) {
        switchToFile(state.currentFileIndex + 1, Math.max(0, target - dur), { autoplay: !audio.paused });
        return;
      }
      target = dur;
    }

    audio.currentTime = target;
    persistPosition();
    updateSeekUI();
  }

  function switchAdjacentFile(direction) {
    if (!state.currentBook) return;
    const files = state.currentBook.files || [];
    const next = state.currentFileIndex + direction;
    if (next < 0 || next >= files.length) return;
    switchToFile(next, 0, { autoplay: !audio.paused });
  }

  function updateMediaSessionMetadata(book) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: book.title,
        artist: book.author || '',
        album: 'stacks',
        artwork: book.hasCover
          ? [
            { src: coverUrl(book.id), sizes: '512x512', type: 'image/jpeg' },
            { src: coverUrl(book.id), sizes: '192x192', type: 'image/jpeg' },
          ]
          : [],
      });
    } catch { /* MediaMetadata unsupported */ }

    const handlers = {
      play: () => audio.play().catch(() => {}),
      pause: () => audio.pause(),
      seekbackward: () => seekRelative(-30),
      seekforward: () => seekRelative(30),
      previoustrack: () => switchAdjacentFile(-1),
      nexttrack: () => switchAdjacentFile(1),
    };
    Object.entries(handlers).forEach(([action, handler]) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
    });
  }

  // Monotonic token identifying the most recent enterPlayer() call. Nothing
  // below commits shared state (state.currentBook/currentFileIndex, audio.*,
  // pendingResumeSeconds, isLoadingFile) until every await has resolved AND
  // this call's token is still the current one — see the two await sites
  // below. Without this, opening book B while book A's enterPlayer() call
  // was still mid-await (resolving a queued position / local URL) could let
  // A's *later*-resolving commit overwrite B's already-committed state, or
  // the still-live 10s sync interval (stopped below, before either await)
  // could fire persistPosition() reading a mismatched
  // currentBook/currentFileIndex/currentTime combination and save one
  // book's playback time onto the other's record.
  let enterPlayerToken = 0;

  // async so the queued-position/local-URL lookups below can be awaited
  // *before* the player screen (and its play button) even appears — never
  // inside a tap handler. openBook() already awaits this; there's no
  // autoplay here, so the extra microtask delay never sits between a user
  // gesture and audio.play().
  async function enterPlayer(book) {
    // Stopped immediately, before either await — see the token comment
    // above for why. Restarted naturally once the new book's audio actually
    // starts playing (the 'play' handler calls startSyncInterval()).
    stopSyncInterval();
    const myToken = ++enterPlayerToken;

    clearSleepTimer();
    // Cached durations are keyed by file index only, not book id — a stale
    // entry from a previous book would otherwise silently resolve
    // getFileDuration() to the wrong book's duration for the same index (see
    // seekRelative's backward-crossing branch), producing a bogus seek that
    // then gets persisted as the real position.
    Object.keys(fileDurationCache).forEach((key) => { delete fileDurationCache[key]; });

    let resumeFileIndex = (book.position && book.position.fileIndex) || 0;
    let resumeSeconds = (book.position && book.position.seconds) || 0;
    // A locally-queued position (written by persistPosition() whenever the
    // server POST fails — see queuePosition() there) is, by construction,
    // always at least as new as book.position: it only still exists because
    // the server hasn't acknowledged it yet (a direct success drops it —
    // see persistPosition() — and flushPositionQueue() clears it once a
    // replay lands). That's true both while fully offline (the flight
    // scenario this feature exists for — close the app mid-book, reopen
    // still offline, resume exactly where you left off) and, briefly, right
    // after reconnecting but before the queue has finished draining. No
    // timestamp comparison needed — presence alone means "newer."
    if (offlineReady && typeof offline.getQueuedPosition === 'function') {
      try {
        const queued = await offline.getQueuedPosition(book.id);
        if (myToken !== enterPlayerToken) return; // superseded by a newer enterPlayer() call
        if (queued) {
          resumeFileIndex = queued.fileIndex || 0;
          resumeSeconds = queued.seconds || 0;
        }
      } catch { /* fall back to book.position */ }
    }

    let src = mediaUrl(book.id, resumeFileIndex);
    let resolvedLocalUrl = null;
    if (offlineReady) {
      try {
        const localUrl = await offline.getLocalMediaUrl(book.id, resumeFileIndex);
        if (myToken !== enterPlayerToken) {
          // Superseded while this awaited — release rather than leak; the
          // winning call already has (or will resolve) its own local URL.
          if (localUrl) { try { offline.releaseMediaUrl(localUrl); } catch { /* best effort */ } }
          return;
        }
        if (localUrl) { src = localUrl; resolvedLocalUrl = localUrl; }
      } catch { /* fall back to streaming */ }
    }

    // Committing: every await above resolved and no newer enterPlayer() call
    // has started since — safe to mutate shared state now, all at once.
    // Leaving the previous book (if any) behind — release every local URL
    // it was holding, including any background-prefetched-but-unused ones.
    releasePlayerLocalUrls();
    state.currentBook = book;
    state.currentFileIndex = resumeFileIndex;

    renderPlayerMeta(book);
    renderChapters();
    updateFileLabel();
    updateMediaSessionMetadata(book);
    setPlayIcon(false);

    pendingResumeSeconds = resumeSeconds;
    pendingResumeFromEnd = null;
    isLoadingFile = true;

    if (resolvedLocalUrl) {
      currentLocalUrl = resolvedLocalUrl;
      localFileUrlCache[resumeFileIndex] = resolvedLocalUrl;
    }
    audio.src = src;
    audio.load();
    audio.playbackRate = readSpeedPreference();
    els.speedBtn.textContent = `${formatSpeedLabel(audio.playbackRate)}×`;

    armedChapterKey = null;
    showScreen('player');
    renderDownloadUI();
    // Warms the neighboring file(s) so a downloaded multi-file book can
    // play through offline — see prefetchNeighbors()'s doc comment.
    prefetchNeighbors(book.id, resumeFileIndex);
  }

  els.playerBackBtn.addEventListener('click', () => {
    releaseUnusedLocalUrls();
    closeSheet(els.downloadPanel);
    showScreen('library');
    renderLibrary(); // pick up any download-status changes made from the player
  });

  els.playPauseBtn.addEventListener('click', () => {
    if (audio.paused) {
      audio.play().catch(() => { /* blocked — user can tap again */ });
    } else {
      audio.pause();
    }
  });

  els.back30Btn.addEventListener('click', () => seekRelative(-30));
  els.fwd30Btn.addEventListener('click', () => seekRelative(30));

  els.seekBar.addEventListener('input', () => {
    isSeeking = true;
    const dur = getDuration();
    if (dur) {
      const t = (Number(els.seekBar.value) / 1000) * dur;
      updateTimeLabels(t, dur);
    }
  });
  els.seekBar.addEventListener('change', () => {
    const dur = getDuration();
    if (dur) {
      const t = (Number(els.seekBar.value) / 1000) * dur;
      audio.currentTime = t;
      persistPosition();
    }
    isSeeking = false;
  });

  audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      fileDurationCache[state.currentFileIndex] = audio.duration;
    }
    if (pendingResumeFromEnd != null) {
      const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
      const resolved = Math.max(0, dur - pendingResumeFromEnd);
      pendingResumeFromEnd = null;
      try { audio.currentTime = resolved; } catch { /* ignore */ }
      persistPosition(resolved);
    } else if (pendingResumeSeconds != null) {
      try { audio.currentTime = pendingResumeSeconds; } catch { /* ignore */ }
      pendingResumeSeconds = null;
    }
    isLoadingFile = false;
    updateSeekUI();
    updateMediaSessionPositionState();
    updateActiveChapterUI();
    // Re-warms neighbors around whichever file just finished loading — the
    // `ended` handler's switchToFile(index + 1, …), a chapter jump, ±30s
    // crossing a boundary, and prev/next-track all land here too, so this
    // keeps the *next* file's local URL ready one step ahead throughout the
    // whole book, not just at the moment the player was first opened.
    if (state.currentBook) prefetchNeighbors(state.currentBook.id, state.currentFileIndex);
  });

  audio.addEventListener('timeupdate', () => {
    updateSeekUI();
    updateActiveChapterUI();
    updateMediaSessionPositionState();
  });

  audio.addEventListener('play', () => {
    setPlayIcon(true);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    startSyncInterval();
  });

  audio.addEventListener('pause', () => {
    setPlayIcon(false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    stopSyncInterval();
    // audio.load() (called from switchToFile/enterPlayer) synchronously
    // fires this event with currentTime reset to 0 — don't let that clobber
    // the resume position we just intentionally persisted for the new file.
    if (!isLoadingFile) persistPosition();
  });

  audio.addEventListener('ended', () => {
    const files = (state.currentBook && state.currentBook.files) || [];
    if (state.currentFileIndex < files.length - 1) {
      switchToFile(state.currentFileIndex + 1, 0, { autoplay: true });
    } else {
      persistPosition();
    }
  });

  audio.addEventListener('error', () => {
    isLoadingFile = false;
    if (state.currentBook) setOffline(true);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistPositionBeacon();
    // App foreground — a plausible moment for connectivity to have returned
    // (e.g. reopening the app after landing) even before any request fires.
    else if (document.visibilityState === 'visible') flushPositionQueue();
  });
  window.addEventListener('pagehide', () => {
    persistPositionBeacon();
  });
  window.addEventListener('online', () => {
    flushPositionQueue();
    if (state.isOfflineMode) retryConnection();
  });

  // ---------------------------------------------------------------------
  // Bottom sheets (chapters / speed / sleep)
  // ---------------------------------------------------------------------
  function openSheet(panel, triggerBtn) {
    panel.hidden = false;
    if (triggerBtn) triggerBtn.setAttribute('aria-expanded', 'true');
  }
  function closeSheet(panel) {
    panel.hidden = true;
    document.querySelectorAll('[aria-controls]').forEach((btn) => {
      if (document.getElementById(btn.getAttribute('aria-controls')) === panel) {
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }
  document.querySelectorAll('[data-close-sheet]').forEach((el) => {
    el.addEventListener('click', () => closeSheet(el.closest('.sheet')));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    [els.chaptersPanel, els.speedPanel, els.sleepPanel, els.downloadPanel].forEach((p) => {
      if (!p.hidden) closeSheet(p);
    });
  });

  els.playerChaptersBtn.addEventListener('click', () => {
    updateActiveChapterUI();
    openSheet(els.chaptersPanel, els.playerChaptersBtn);
  });

  // Speed
  function formatSpeedLabel(v) {
    return String(v);
  }
  function readSpeedPreference() {
    const stored = Number(localStorage.getItem('stacks:playbackRate'));
    return SPEED_OPTIONS.includes(stored) ? stored : 1;
  }
  function renderSpeedOptions() {
    els.speedOptions.innerHTML = '';
    SPEED_OPTIONS.forEach((v) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option-btn' + (audio.playbackRate === v ? ' active' : '');
      btn.textContent = `${formatSpeedLabel(v)}×`;
      btn.addEventListener('click', () => {
        audio.playbackRate = v;
        localStorage.setItem('stacks:playbackRate', String(v));
        els.speedBtn.textContent = `${formatSpeedLabel(v)}×`;
        updateMediaSessionPositionState();
        renderSpeedOptions();
        closeSheet(els.speedPanel);
      });
      els.speedOptions.appendChild(btn);
    });
  }
  els.speedBtn.addEventListener('click', () => {
    renderSpeedOptions();
    openSheet(els.speedPanel, els.speedBtn);
  });

  // Sleep timer
  function clearSleepTimer() {
    if (sleepTimeoutId) { clearTimeout(sleepTimeoutId); sleepTimeoutId = null; }
    if (sleepFadeIntervalId) { clearInterval(sleepFadeIntervalId); sleepFadeIntervalId = null; }
    sleepEndOfChapter = false;
    armedChapterKey = null;
    audio.volume = 1;
    els.sleepLabel.textContent = 'Sleep';
  }

  function fadeOutAndPause() {
    if (sleepFadeIntervalId) return;
    const steps = 20;
    const stepMs = SLEEP_FADE_MS / steps;
    let i = 0;
    sleepFadeIntervalId = setInterval(() => {
      i += 1;
      audio.volume = Math.max(0, 1 - i / steps);
      if (i >= steps) {
        clearInterval(sleepFadeIntervalId);
        sleepFadeIntervalId = null;
        audio.pause();
        audio.volume = 1;
      }
    }, stepMs);
  }

  function armSleepMinutes(minutes) {
    clearSleepTimer();
    els.sleepLabel.textContent = `${minutes}m`;
    const fadeStart = Math.max(0, minutes * 60000 - SLEEP_FADE_MS);
    sleepTimeoutId = setTimeout(() => {
      // The timer has fired and is no longer "armed" — clear the id and
      // label now so the sleep panel shows "Off" instead of still claiming
      // e.g. "30m" once fadeOutAndPause finishes.
      sleepTimeoutId = null;
      els.sleepLabel.textContent = 'Sleep';
      fadeOutAndPause();
    }, fadeStart);
  }

  function armSleepEndOfChapter() {
    clearSleepTimer();
    sleepEndOfChapter = true;
    const chapters = getChapters(state.currentBook);
    const idx = currentChapterIndex(chapters, state.currentFileIndex, audio.currentTime || 0);
    armedChapterKey = `${state.currentFileIndex}:${idx}`;
    els.sleepLabel.textContent = 'End of chapter';
  }

  function renderSleepOptions() {
    els.sleepOptions.innerHTML = '';
    const offBtn = document.createElement('button');
    offBtn.type = 'button';
    offBtn.className = 'option-btn' + (!sleepTimeoutId && !sleepEndOfChapter ? ' active' : '');
    offBtn.textContent = 'Off';
    offBtn.addEventListener('click', () => { clearSleepTimer(); closeSheet(els.sleepPanel); });
    els.sleepOptions.appendChild(offBtn);

    SLEEP_OPTIONS.forEach((minutes) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option-btn';
      btn.textContent = `${minutes}m`;
      btn.addEventListener('click', () => { armSleepMinutes(minutes); closeSheet(els.sleepPanel); });
      els.sleepOptions.appendChild(btn);
    });

    const eocBtn = document.createElement('button');
    eocBtn.type = 'button';
    eocBtn.className = 'option-btn' + (sleepEndOfChapter ? ' active' : '');
    eocBtn.textContent = 'End of chapter';
    eocBtn.addEventListener('click', () => { armSleepEndOfChapter(); closeSheet(els.sleepPanel); });
    els.sleepOptions.appendChild(eocBtn);
  }
  els.sleepBtn.addEventListener('click', () => {
    renderSleepOptions();
    openSheet(els.sleepPanel, els.sleepBtn);
  });

  // ---------------------------------------------------------------------
  // Offline downloads — player-screen control (pill + bottom sheet)
  // ---------------------------------------------------------------------
  function currentBookDownloadState() {
    if (!state.currentBook) return null;
    return downloadsIndex[state.currentBook.id] || null;
  }

  // No 'busy' branch here: downloadBook() can return { error: 'busy' } as
  // its direct resolved value, but that's never persisted to meta.error, so
  // it never shows up in dl.error read back from listDownloads()/
  // downloadsIndex — and handleStartDownload() already refuses to call
  // downloadBook() a second time while activeDownloadBookId is set to a
  // different book, so the UI never reaches this function with that code.
  function downloadErrorMessage(code) {
    if (code === 'network') return "Couldn't reach stacks — check your connection and try again.";
    if (code === 'quota_exceeded') return "Your device is out of storage space. What's already downloaded is kept — free up space, then retry to resume.";
    if (code === 'integrity_mismatch') return "The downloaded file didn't match what was expected — try again.";
    return 'Something went wrong. Try again.';
  }

  /** Player-screen pill: reflects state without opening the sheet. Updated
   * on every onProgress tick (see handleStartDownload) — only touches this
   * small pill's text/width, never audio state, so it can't jank playback. */
  function renderDownloadUI() {
    if (!offlineReady || !state.currentBook) {
      els.downloadBtn.hidden = true;
      return;
    }
    els.downloadBtn.hidden = false;
    const dl = currentBookDownloadState();
    const status = dl ? dl.status : 'none';
    els.downloadBtn.classList.remove('state-complete', 'state-error');
    const existingFill = els.downloadBtn.querySelector('.download-pill-progress');
    if (existingFill) existingFill.remove();

    if (status === 'downloading') {
      const pct = dl.bytesTotal ? Math.round((dl.bytesDone / dl.bytesTotal) * 100) : 0;
      els.downloadBtnLabel.textContent = `${pct}%`;
      const fill = document.createElement('span');
      fill.className = 'download-pill-progress';
      fill.style.width = `${pct}%`;
      els.downloadBtn.insertBefore(fill, els.downloadBtn.firstChild);
    } else if (status === 'partial') {
      els.downloadBtnLabel.textContent = 'Resume';
    } else if (status === 'complete') {
      els.downloadBtn.classList.add('state-complete');
      els.downloadBtnLabel.textContent = 'Downloaded';
    } else if (status === 'error') {
      els.downloadBtn.classList.add('state-error');
      els.downloadBtnLabel.textContent = 'Retry';
    } else {
      els.downloadBtnLabel.textContent = 'Download';
    }
  }

  function renderDownloadPanel() {
    const book = state.currentBook;
    els.downloadPanelBody.innerHTML = '';
    if (!book) return;
    const dl = currentBookDownloadState();
    const status = dl ? dl.status : 'none';

    const addEl = (tag, cls, text) => {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      if (text) el.textContent = text;
      els.downloadPanelBody.appendChild(el);
      return el;
    };
    const addActions = (buttons) => {
      const row = document.createElement('div');
      row.className = 'download-panel-actions';
      buttons.forEach((b) => row.appendChild(b));
      els.downloadPanelBody.appendChild(row);
    };
    const makeBtn = (label, cls, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${cls}`;
      btn.textContent = label;
      btn.addEventListener('click', onClick);
      return btn;
    };

    if (status === 'complete') {
      addEl('p', 'download-panel-size', `Downloaded — ${formatBytes(dl.bytesTotal)}`);
      addEl('p', 'download-panel-caption', 'Available offline on this device.');
      addActions([makeBtn('Delete download', 'btn-danger-ghost', () => handleDeleteDownload(book.id, book.title))]);
    } else if (status === 'downloading') {
      const pct = dl.bytesTotal ? Math.round((dl.bytesDone / dl.bytesTotal) * 100) : 0;
      addEl('p', 'download-panel-size', dl.bytesTotal
        ? `${formatBytes(dl.bytesDone)} of ${formatBytes(dl.bytesTotal)} (${pct}%)`
        : 'Starting…');
      const track = addEl('div', 'download-progress-track');
      const fill = document.createElement('div');
      fill.className = 'download-progress-fill';
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      addActions([makeBtn('Cancel download', 'btn-ghost', () => handleCancelDownload(book.id))]);
    } else if (status === 'partial') {
      addEl('p', 'download-panel-size', dl.bytesTotal
        ? `Paused — ${formatBytes(dl.bytesDone)} of ${formatBytes(dl.bytesTotal)}`
        : 'Download paused');
      // A failed resume attempt doesn't change `status` away from 'partial'
      // (the engine only persists error state for a handful of cases — see
      // lastDownloadError's declaration) — without this, the Resume button
      // would look inert after a resume attempt that visibly did nothing.
      if (lastDownloadError && lastDownloadError.bookId === book.id) {
        addEl('p', 'download-panel-caption', downloadErrorMessage(lastDownloadError.code));
      } else {
        addEl('p', 'download-panel-caption', "Resuming continues from where it left off — nothing already downloaded is lost.");
      }
      addActions([
        makeBtn('Resume download', 'btn-primary', () => handleStartDownload(book)),
        makeBtn('Delete', 'btn-danger-ghost', () => handleDeleteDownload(book.id, book.title)),
      ]);
    } else if (status === 'error') {
      addEl('p', 'download-panel-size', 'Download failed');
      addEl('p', 'download-panel-caption', downloadErrorMessage(dl && dl.error));
      addActions([
        makeBtn('Retry', 'btn-primary', () => handleStartDownload(book)),
        makeBtn('Delete', 'btn-danger-ghost', () => handleDeleteDownload(book.id, book.title)),
      ]);
    } else {
      const estimate = estimateDownloadBytes(book);
      const sizeEl = addEl('p', 'download-panel-size', estimate
        ? `Approximately ${formatBytes(estimate)}`
        : 'Size unknown until the download starts');
      addEl('p', 'download-panel-caption', 'Downloads use your data connection — audio is roughly 30 MB per hour. Avoid starting a large download on cellular unless you have data to spare.');
      // Same as the 'partial' branch above: a failed *first* attempt (e.g.
      // no connection at all) leaves `status` at 'none' since nothing ever
      // landed on disk — surface it here too rather than silently reverting
      // to a plain "Download" button as if nothing had just happened.
      if (lastDownloadError && lastDownloadError.bookId === book.id) {
        addEl('p', 'download-panel-caption', downloadErrorMessage(lastDownloadError.code));
      }
      if (activeDownloadBookId && activeDownloadBookId !== book.id) {
        addEl('p', 'download-panel-caption', 'Finish or cancel the current download first — only one book downloads at a time.');
      } else {
        addActions([makeBtn('Start download', 'btn-primary', () => handleStartDownload(book))]);
      }
      // Don't block the sheet on this — it's rendered with the duration-based
      // estimate (or the honest "unknown") above immediately; the exact
      // figure (HEAD + Content-Length per file) swaps in once it resolves,
      // if it resolves at all (offline / a failed HEAD legitimately
      // resolves {bytes: null}, in which case the estimate just stays put).
      fetchExactDownloadSize(book, sizeEl);
    }
  }

  let remoteSizeRequestToken = 0;
  async function fetchExactDownloadSize(book, sizeEl) {
    if (!offlineReady || typeof offline.getRemoteSize !== 'function') return;
    const token = ++remoteSizeRequestToken;
    let result = null;
    try { result = await offline.getRemoteSize(book); } catch { result = null; }
    if (token !== remoteSizeRequestToken) return; // a newer panel render superseded this request
    if (els.downloadPanel.hidden) return; // sheet was closed while this was in flight
    if (!state.currentBook || state.currentBook.id !== book.id) return; // book changed
    const dl = currentBookDownloadState();
    if ((dl ? dl.status : 'none') !== 'none') return; // download started/etc. — this figure no longer applies
    if (result && result.bytes != null && Number.isFinite(result.bytes)) {
      sizeEl.textContent = `${formatBytes(result.bytes)} to download`;
    }
    // else: leave the estimate (or "unknown") from the initial render as-is.
  }

  async function handleStartDownload(book) {
    if (!offlineReady || (activeDownloadBookId && activeDownloadBookId !== book.id)) return;
    // A fresh attempt supersedes whatever the last one left behind.
    if (lastDownloadError && lastDownloadError.bookId === book.id) lastDownloadError = null;
    activeDownloadBookId = book.id;
    downloadsIndex[book.id] = { ...(downloadsIndex[book.id] || {}), bookId: book.id, status: 'downloading', bytesDone: 0, bytesTotal: 0 };
    renderDownloadUI();
    if (!els.downloadPanel.hidden) renderDownloadPanel();
    renderLibrary();
    let result = null;
    try {
      result = await offline.downloadBook(book, {
        onProgress: (p) => {
          downloadsIndex[book.id] = { ...(downloadsIndex[book.id] || {}), bookId: book.id, status: 'downloading', bytesDone: p.bytesDone, bytesTotal: p.bytesTotal };
          if (state.currentBook && state.currentBook.id === book.id) {
            renderDownloadUI();
            if (!els.downloadPanel.hidden) renderDownloadPanel();
          }
        },
      });
    } catch {
      result = null;
    }
    activeDownloadBookId = null;
    await refreshDownloadsIndex();
    if (result && result.status === 'complete') {
      lastDownloadError = null;
    } else if (result && result.error) {
      // The engine doesn't persist every failure mode to meta.error (e.g. a
      // transient 'network' failure mid-attempt never touches storage), so
      // downloadsIndex alone can't be trusted to reflect that this attempt
      // just failed — track it here so renderDownloadPanel() can still say
      // so instead of silently reverting to "Download"/"Resume".
      lastDownloadError = { bookId: book.id, code: result.error };
    }
    if (state.currentBook && state.currentBook.id === book.id) {
      renderDownloadUI();
      if (!els.downloadPanel.hidden) renderDownloadPanel();
    }
    renderLibrary();
    if (result && result.status === 'complete') await maybeRequestPersistence();
  }

  async function handleCancelDownload(bookId) {
    if (!offlineReady) return;
    try { await offline.cancelDownload(bookId); } catch { /* best effort */ }
    if (activeDownloadBookId === bookId) activeDownloadBookId = null;
    await refreshDownloadsIndex();
    if (state.currentBook && state.currentBook.id === bookId) {
      renderDownloadUI();
      if (!els.downloadPanel.hidden) renderDownloadPanel();
    }
    renderLibrary();
  }

  async function handleDeleteDownload(bookId, title) {
    if (!offlineReady) return;
    if (!window.confirm(`Delete the download for "${title || 'this book'}"? You can download it again anytime.`)) return;
    if (lastDownloadError && lastDownloadError.bookId === bookId) lastDownloadError = null;
    try { await offline.deleteDownload(bookId); } catch { /* best effort */ }
    await refreshDownloadsIndex();
    if (state.currentBook && state.currentBook.id === bookId) {
      renderDownloadUI();
      if (!els.downloadPanel.hidden) renderDownloadPanel();
    }
    renderLibrary();
    if (state.screen === 'downloads') renderDownloadsScreen();
  }

  els.downloadBtn.addEventListener('click', () => {
    renderDownloadPanel();
    openSheet(els.downloadPanel, els.downloadBtn);
  });

  // ---------------------------------------------------------------------
  // Persistent storage prompt — one-time, quiet, honest about the failure
  // case rather than alarming (requirement 6).
  // ---------------------------------------------------------------------
  async function maybeRequestPersistence() {
    if (!offlineReady || typeof offline.requestPersistence !== 'function') return;
    if (localStorage.getItem('stacks:persistenceChecked')) return;
    localStorage.setItem('stacks:persistenceChecked', '1');
    let granted = false;
    try { granted = await offline.requestPersistence(); } catch { granted = false; }
    localStorage.setItem('stacks:persistenceGranted', granted ? '1' : '0');
  }

  function renderPersistenceNote() {
    const granted = localStorage.getItem('stacks:persistenceGranted');
    const dismissed = localStorage.getItem('stacks:persistenceNoteDismissed');
    const shouldShow = granted === '0' && !dismissed;
    els.persistenceNote.hidden = !shouldShow;
    if (shouldShow) {
      els.persistenceNoteText.textContent = "Downloads are stored in this browser. If you don’t open stacks for a long time, iOS may clear them to free up space — reopen occasionally to keep your offline books.";
    }
  }
  els.persistenceNoteDismiss.addEventListener('click', () => {
    localStorage.setItem('stacks:persistenceNoteDismissed', '1');
    els.persistenceNote.hidden = true;
  });

  // ---------------------------------------------------------------------
  // Downloads management screen
  // ---------------------------------------------------------------------
  function buildDownloadRow(entry, onDelete) {
    const li = document.createElement('li');
    li.className = 'downloads-row';

    const cover = document.createElement('div');
    cover.className = 'book-cover downloads-row-cover';
    cover.style.background = gradientFor(`${entry.title || ''}${entry.author || ''}`);
    cover.textContent = initialsFor(entry.title || '');
    li.appendChild(cover);

    const info = document.createElement('div');
    info.className = 'downloads-row-info';
    const title = document.createElement('div');
    title.className = 'downloads-row-title';
    title.textContent = entry.title || 'Untitled';
    info.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'downloads-row-meta';
    let sizeText;
    if (entry.status === 'complete') sizeText = formatBytes(entry.bytesTotal);
    else if (entry.status === 'error') sizeText = 'Download failed';
    else sizeText = `${formatBytes(entry.bytesDone)}${entry.bytesTotal ? ` of ${formatBytes(entry.bytesTotal)}` : ''}`;
    meta.textContent = entry.author ? `${entry.author} — ${sizeText}` : sizeText;
    info.appendChild(meta);
    li.appendChild(info);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn downloads-row-delete';
    delBtn.setAttribute('aria-label', `Delete ${entry.title || 'download'}`);
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" /></svg>';
    delBtn.addEventListener('click', onDelete);
    li.appendChild(delBtn);

    return li;
  }

  async function renderDownloadsScreen() {
    if (!offlineReady) return;
    await refreshDownloadsIndex();

    // Storage summary — getStorageEstimate() is only meaningful on a secure
    // context (navigator.storage is HTTPS-only), which the phone server
    // plain-HTTP LAN origin isn't, so `supported` is normally false here;
    // fall back to the total of stacks' own downloads rather than pretending
    // to know the device's total capacity.
    els.downloadsStorage.innerHTML = '';
    let estimate = null;
    try { estimate = await offline.getStorageEstimate(); } catch { estimate = null; }
    const entries = Object.values(downloadsIndex);
    const ownBytes = entries.reduce((sum, d) => sum + (d.bytesDone || 0), 0);

    if (estimate && estimate.supported) {
      const usedRow = document.createElement('div');
      usedRow.className = 'downloads-storage-row';
      usedRow.innerHTML = `<span>Used by stacks</span><span class="downloads-storage-value">${formatBytes(estimate.usage)}</span>`;
      els.downloadsStorage.appendChild(usedRow);
      const quotaRow = document.createElement('div');
      quotaRow.className = 'downloads-storage-row';
      quotaRow.innerHTML = `<span>Device storage</span><span class="downloads-storage-value">${formatBytes(estimate.quota)} total</span>`;
      els.downloadsStorage.appendChild(quotaRow);
      const bar = document.createElement('div');
      bar.className = 'downloads-storage-bar';
      const fill = document.createElement('div');
      fill.className = 'downloads-storage-bar-fill';
      fill.style.width = `${estimate.quota ? Math.min(100, (estimate.usage / estimate.quota) * 100) : 0}%`;
      bar.appendChild(fill);
      els.downloadsStorage.appendChild(bar);
      const caption = document.createElement('p');
      caption.className = 'downloads-storage-caption';
      caption.textContent = estimate.persisted
        ? 'Persistent storage granted — iOS won’t clear these downloads to free up space.'
        : 'Storage isn’t marked persistent — iOS may clear downloads if the device runs low on space or the app goes unused for a long time.';
      els.downloadsStorage.appendChild(caption);
    } else {
      const usedRow = document.createElement('div');
      usedRow.className = 'downloads-storage-row';
      usedRow.innerHTML = `<span>Used by downloads</span><span class="downloads-storage-value">${formatBytes(ownBytes)}</span>`;
      els.downloadsStorage.appendChild(usedRow);
      const caption = document.createElement('p');
      caption.className = 'downloads-storage-caption';
      caption.textContent = "Total device storage isn't available over this connection — this is just the space stacks' own downloads are using.";
      els.downloadsStorage.appendChild(caption);
    }

    renderPersistenceNote();

    // Downloaded list
    els.downloadsList.innerHTML = '';
    if (entries.length === 0) {
      els.downloadsEmpty.hidden = false;
    } else {
      els.downloadsEmpty.hidden = true;
      entries
        .slice()
        .sort((a, b) => (a.title || '').localeCompare(b.title || ''))
        .forEach((d) => {
          els.downloadsList.appendChild(buildDownloadRow(d, () => handleDeleteDownload(d.bookId, d.title)));
        });
    }
    els.deleteAllDownloadsBtn.hidden = entries.length === 0;

    // Orphans — downloaded but no longer present in the (last-known) library
    let orphans = [];
    try { orphans = await offline.findOrphans(state.books.map((b) => b.id)); } catch { orphans = []; }
    els.downloadsOrphansSection.hidden = !orphans || orphans.length === 0;
    els.downloadsOrphansList.innerHTML = '';
    (orphans || []).forEach((o) => {
      els.downloadsOrphansList.appendChild(buildDownloadRow(
        { title: o.title, author: o.author, bytesTotal: o.bytesTotal, status: 'complete' },
        () => handleDeleteDownload(o.bookId, o.title),
      ));
    });
  }

  els.openDownloadsBtn.addEventListener('click', () => {
    showScreen('downloads');
    renderDownloadsScreen();
  });
  els.downloadsBackBtn.addEventListener('click', () => {
    showScreen('library');
  });
  els.deleteAllDownloadsBtn.addEventListener('click', async () => {
    if (!offlineReady) return;
    const entries = Object.values(downloadsIndex);
    if (entries.length === 0) return;
    if (!window.confirm(`Delete all ${entries.length} downloaded book${entries.length === 1 ? '' : 's'}? This can't be undone.`)) return;
    els.deleteAllDownloadsBtn.disabled = true;
    try {
      await Promise.all(entries.map((d) => offline.deleteDownload(d.bookId).catch(() => {})));
    } finally {
      els.deleteAllDownloadsBtn.disabled = false;
    }
    await refreshDownloadsIndex();
    renderDownloadsScreen();
    renderLibrary();
    if (state.currentBook) renderDownloadUI();
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  async function checkSession() {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    setOffline(false);
    return res.status === 200;
  }

  async function boot() {
    showScreen('loading');
    await initOfflineEngine();
    try {
      const authed = await checkSession();
      if (authed) {
        authLost = false;
        await enterLibrary();
      } else {
        showScreen('pin');
      }
    } catch {
      setOffline(true);
      if (offlineReady) {
        // "Open the app on a plane" case — the server is completely
        // unreachable, but downloaded books should still just play.
        await enterOfflineLibrary();
      } else {
        showScreen('pin');
      }
    }
  }

  boot();
})();
