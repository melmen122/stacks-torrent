// stacks — mobile web app.
// Plain vanilla JS, no build step, no dependencies. Talks to the same-origin
// HTTP API served by the Electron app's phone server (see the API contract
// notes throughout). Designed for Safari on iOS/iPadOS, "Add to Home
// Screen" standalone mode.
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------
  const els = {
    offlineBanner: document.getElementById('offline-banner'),
    offlineRetry: document.getElementById('offline-retry'),

    screens: {
      loading: document.getElementById('screen-loading'),
      pin: document.getElementById('screen-pin'),
      library: document.getElementById('screen-library'),
      player: document.getElementById('screen-player'),
    },

    pinForm: document.getElementById('pin-form'),
    pinInput: document.getElementById('pin-input'),
    pinSubmit: document.getElementById('pin-submit'),
    pinError: document.getElementById('pin-error'),

    refreshLibraryBtn: document.getElementById('btn-refresh-library'),
    librarySearch: document.getElementById('library-search'),
    genreFilterRow: document.getElementById('genre-filter-row'),
    continueRow: document.getElementById('continue-listening-row'),
    continueList: document.getElementById('continue-listening-list'),
    allBooksTitle: document.getElementById('all-books-title'),
    libraryGrid: document.getElementById('library-grid'),
    libraryEmpty: document.getElementById('library-empty'),

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
  };

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

  function buildCoverEl(book, { withImage = true } = {}) {
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
  // Connectivity / API
  // ---------------------------------------------------------------------
  function setOffline(isOffline) {
    els.offlineBanner.hidden = !isOffline;
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

  async function apiPost(path, body, { silentAuth = false } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

  function retryConnection() {
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
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'book-tile';
    btn.appendChild(buildCoverEl(book));

    const title = document.createElement('span');
    title.className = 'book-tile-title';
    title.textContent = book.title;
    btn.appendChild(title);

    const author = document.createElement('span');
    author.className = 'book-tile-author';
    author.textContent = book.author || '';
    btn.appendChild(author);

    btn.addEventListener('click', () => openBook(book.id));
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

    const continuing = state.books.filter(hasProgress);
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
      state.books = (data && data.books) || [];
      renderLibrary();
    } catch {
      // apiGet already surfaced the offline banner / auth redirect as needed.
    }
  }

  async function enterLibrary() {
    showScreen('library');
    await loadLibrary();
  }

  els.refreshLibraryBtn.addEventListener('click', loadLibrary);
  els.librarySearch.addEventListener('input', () => {
    state.searchQuery = els.librarySearch.value;
    renderLibrary();
  });
  els.offlineRetry.addEventListener('click', retryConnection);

  async function openBook(id) {
    try {
      const book = await apiGet(`/api/books/${encodeURIComponent(id)}`);
      enterPlayer(book);
    } catch (err) {
      if (err.status === 404) {
        // Book disappeared from the library (removed on desktop) — refresh.
        loadLibrary();
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
    apiPost('/api/position', {
      bookId: state.currentBook.id,
      fileIndex: state.currentFileIndex,
      seconds,
    }).catch(() => {});
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
  function switchToFile(index, seconds, { autoplay = false, secondsFromEnd = null } = {}) {
    state.currentFileIndex = index;
    isLoadingFile = true;
    if (secondsFromEnd != null) {
      pendingResumeSeconds = null;
      pendingResumeFromEnd = secondsFromEnd;
    } else {
      pendingResumeSeconds = seconds || 0;
      pendingResumeFromEnd = null;
    }
    audio.src = mediaUrl(state.currentBook.id, index);
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

  function enterPlayer(book) {
    clearSleepTimer();
    // Cached durations are keyed by file index only, not book id — a stale
    // entry from a previous book would otherwise silently resolve
    // getFileDuration() to the wrong book's duration for the same index (see
    // seekRelative's backward-crossing branch), producing a bogus seek that
    // then gets persisted as the real position.
    Object.keys(fileDurationCache).forEach((key) => { delete fileDurationCache[key]; });
    state.currentBook = book;
    state.currentFileIndex = (book.position && book.position.fileIndex) || 0;
    const resumeSeconds = (book.position && book.position.seconds) || 0;

    renderPlayerMeta(book);
    renderChapters();
    updateFileLabel();
    updateMediaSessionMetadata(book);
    setPlayIcon(false);

    pendingResumeSeconds = resumeSeconds;
    pendingResumeFromEnd = null;
    isLoadingFile = true;
    audio.src = mediaUrl(book.id, state.currentFileIndex);
    audio.load();
    audio.playbackRate = readSpeedPreference();
    els.speedBtn.textContent = `${formatSpeedLabel(audio.playbackRate)}×`;

    armedChapterKey = null;
    showScreen('player');
  }

  els.playerBackBtn.addEventListener('click', () => {
    showScreen('library');
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
  });
  window.addEventListener('pagehide', () => {
    persistPositionBeacon();
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
    [els.chaptersPanel, els.speedPanel, els.sleepPanel].forEach((p) => {
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
  // Boot
  // ---------------------------------------------------------------------
  async function checkSession() {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    setOffline(false);
    return res.status === 200;
  }

  async function boot() {
    showScreen('loading');
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
      showScreen('pin');
    }
  }

  boot();
})();
