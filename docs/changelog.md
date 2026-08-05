# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Phase 4] — Safety Features (Pre-Download Filtering + VirusTotal Scanning)

### Added

#### Layer 1 — Pre-Download Safety Check (Always On, Local Only)
- **Automatic manifest-based filtering** — Before any file content is downloaded, the app inspects the torrent's file manifest and downloads ONLY audio files (plus small cover images ≤5MB)
  - Executables (.exe, .scr, .bat, .msi, .cmd, .com, .vbs, .ps1, .app, .dmg, .deb, .rpm, .sh, and ~50 other executable extensions) are never selected
  - Disguised files (final extension is executable + preceding media/doc extension, e.g. `Chapter 1.mp3.exe`) are detected and blocked
  - Archives (.zip, .rar, .7z, .tar, .gz, .bz2, .xz, .iso, .cab) are never selected
  - Unrecognized file extensions are never selected
  - Filename tricks (trailing dots/spaces, Unicode RTL overrides) are normalized before classification
  - Works identically for magnet links and .torrent files
- **Safety verdict badge** on each torrent row: clean ✓ / caution ⚠ / danger ⛔
  - Shows "checking…" while metadata is arriving
  - Click badge to view detailed report of all skipped files and reasons
  - Categorizes skipped files: executable, disguised, archive, companion (benign images/metadata), other (unknown)
- **No-audio guard** — If a torrent contains no audio files (only archives/executables), nothing is downloaded; row warns user and offers remove action
- **Automatic cleanup** — After download completes, any stray bytes of skipped files are deleted (BitTorrent pieces can straddle file boundaries)
- Core module: `electron/lib/safetyCheck.js` with pure `classifyTorrentFiles()` function
- IPC event: `torrents:safety-report` with verdict, hasAudio, skipped file list, counts

#### Layer 2 — VirusTotal Scanning (Opt-in, Post-Download)
- **Hash-based file scanning** — After a book downloads, each audio file is SHA-256 hashed and looked up in VirusTotal's database (hashes only; file contents never uploaded)
  - Requires free API key from [virustotal.com](https://virustotal.com)
  - Scans run in the background after download completes
  - Results cached locally (30-day TTL) to avoid redundant lookups
  - Rate-limited to 4 requests/minute (free tier), so large audiobooks scan sequentially in the background
- **Scan verdict** per book: clean ✓ / suspicious ⚠ / infected ⛔ / unknown (neutral, not a safety signal)
- **Infected book handling** — Persistent red alert on the library card + toast notification; one-click remove (files not auto-deleted)
- **Settings panel** — New "Virus scanning (VirusTotal)" section:
  - API key input (stored locally in settings.json as plaintext, never logged or sent to renderer)
  - "Get a free key" link to virustotal.com
  - Status indicator and honest caption: scans run AFTER download using file hashes; free tier is rate-limited; complements but does not replace OS antivirus
- **Automatic on-launch scan** — When app launches, previously-unscanned books are queued automatically if VT enabled
- **Manual re-scan** — Book menu → "Scan for viruses" / "Re-scan for viruses" (disabled with hint if no key)
- Core modules:
  - `electron/lib/virusTotal.js` — API wrapper (hashFile, lookupHash, verdict mapping)
  - `electron/lib/scanQueue.js` — Rate-limited queue with caching (4 req/min, 30d TTL)
  - `electron/lib/virusTotalCache.js` — Local cache persistence (vt-cache.json)
  - `electron/lib/virusTotalScanner.js` — Hash calculation & background orchestration
- IPC methods: `virusTotal:getSettings`, `virusTotal:setKey(key)`, `virusTotal:scanBook(bookId)`
- IPC events: `virusTotal:scan-progress`, `virusTotal:scan-complete`
- Data model: `book.scan` field with state, verdict, file hashes, malicious/suspicious counts
- New UI components:
  - `SafetyBadge.jsx` — Pre-download safety verdict display
  - `SafetyDetails.jsx` — Detailed report of skipped files (popover/expand)
  - `ScanBadge.jsx` — VirusTotal scan status (scanning/clean/suspicious/infected/unknown)
  - `VirusTotalContext.jsx` — API wrapper & state management

### Enhanced

#### Dead & Stalled Torrent Feedback
- **Discovery status messaging** — Instead of silently stalling, the Downloads view now shows clear peer-discovery feedback:
  - `'searching'` — Metadata arriving, within grace period, peers being sought
  - `'no-peers'` — After ~2 minutes with zero peers, explains "No peers found — nobody appears to be sharing this torrent right now. It may be dead, or seeders may come online later."
  - `'connected'` — At least one peer connected (never latches; recovers immediately if a peer reappears)
  - Paused downloads are exempt from no-peers reporting
- Helps users distinguish stuck-torrent UX from app hang or network issues
- Discovery status persisted in runtime torrent state; not persisted across restart (safe)

#### Clearer Virus-Scan Results (Layer 2)
- **Scan verdict display refined** — More prominent, self-explanatory boxes:
  - Clean → green "✓ No threats found — checked by VirusTotal"
  - Unknown → neutral "Not in VirusTotal's database" + always-visible explainer: "VirusTotal's knowledge is crowdsourced; audiobooks uploaded by individuals are almost never present. This means no known threats, but not independent verification. Play with confidence."
  - Suspicious → amber warning badge
  - Infected → loud red "MALWARE DETECTED" banner with one-click Remove button (single unified signal, no competing indicators)
- "Unknown" verdict explicitly documented as normal, expected, and safe for audiobooks

#### Provenance Badge on Book Cards (Layer 1)
- **New book-level safety signal** — Each book now shows its Layer 1 verdict at import time, persisted to `book.source`:
  - "✓ Audio-only download" — Torrent contained only audio files and safe companions (covers, metadata)
  - "✓ Audio only — N risky file(s) skipped" — Torrent had non-audio files (executables, archives), which were blocked pre-download and never touched disk. Click badge to list them.
  - No badge = legacy book (added before this field existed) or manually imported; app makes no safety claim
- Benign companion files (.nfo, .cue, cover art ≤5MB) are NOT counted as risky
- Books imported before this update will never gain a badge—absence is "we don't know," not "we checked"
- Honest positive signal since VirusTotal's Layer 2 returns "unknown" for nearly all audiobooks

### Testing
- 130 new unit tests for safety-UX features (231 total):
  - `safetyCheck.test.js` — Exhaustive classification (audio-only, executables, disguised, archives, companions, mixed, no-audio, case-insensitivity, no-extension, counts)
  - `virusTotal.test.js` — Verdict mapping (malicious/suspicious thresholds), response parsing (200/404/401/429/malformed), cache TTL, "unknown" verdict for audiobooks
  - `scanQueue.test.js` — Rate limiting (4 req/min), queue deduplication, exponential backoff on 429
  - `virusTotalCache.test.js` — Persistence, TTL logic, known-hash fast-path
  - `virusTotalScanner.test.js` — Hash calculation, background orchestration
  - `torrents.completion.test.js` — Integration: no-audio guard, auto-import skip
  - `discoveryState.test.js` — Discovery status state machine ('searching' → 'no-peers' → 'connected'), grace period timing, peer detection, paused-state exemption
  - `bookSource.test.js` — Provenance badge persistence (TorrentSource safety verdict at import time), legacy-book handling, detail-list capping

### Documentation
- **README.md**
  - Features: added safety layer summary
  - New **Safety** section: Layer 1 (always on, local, manifest filtering, badge, auto-cleanup) and Layer 2 (opt-in, VT API key setup, hash-based scanning, rate limiting, unknown ≠ safe); honesty caveats (not OS AV replacement, Layer 1 cannot detect malware inside files, Layer 2 post-download only)
  - Settings subsection: VirusTotal key setup steps
  - Where Data Lives: added vt-cache.json
  - Project Structure: new backend modules (safetyCheck.js, virusTotal.js, scanQueue.js, virusTotalCache.js, virusTotalScanner.js) and renderer components (SafetyBadge.jsx, SafetyDetails.jsx, ScanBadge.jsx, VirusTotalContext.jsx)
  - Testing: updated test count (98 → 194); listed safety-specific test suites
- **docs/api.md**
  - `torrentsList()` gains optional `safety` field (verdict, hasAudio, skippedCount)
  - New VirusTotal section: `virusTotal:getSettings()`, `virusTotal:setKey(key)`, `virusTotal:scanBook(bookId)` with descriptions and examples
  - New events: `torrents:safety-report` (pre-download classification), `virusTotal:scan-progress` (per-file scan status), `virusTotal:scan-complete` (book-level verdict)
  - Preload utilities: `virusTotalGetSettings()`, `virusTotalSetKey()`, `virusTotalScanBook()`, `onScanProgress()`, `onScanComplete()`, `onSafetyReport()`
- **docs/models.md**
  - Book model: new `scan` field (state, verdict, scannedAt, file hashes with malicious/suspicious counts)
  - Settings model: new `virusTotalApiKey` and `virusTotalEnabled` fields; note on key handling
  - New VirusTotal Cache section: entry structure, TTL policy, file organization
  - File Organization: added vt-cache.json

### Honesty Constraints (Enforced in UI + Docs)
- Layer 1 is NOT a replacement for OS antivirus and CANNOT detect malware inside a valid audio file
- VirusTotal scans AFTER download; the app does not scan before selecting files
- "Unknown" verdict (file never seen by VirusTotal) is NOT a safety signal and does NOT render as "clean"
- VirusTotal is the one external network call; Layer 1 is entirely local; hashes (not files) leave the machine

## [Phase 3] — Magnet Link Default Handler

### Added
- **Magnet link default handler registration** — Register Audiobook Library as the default app for `magnet:` links
  - Single-instance enforcement: only one app window runs; clicking a magnet while open forwards it to the running window
  - Clicking a magnet link opens the app, focuses the window, switches to Downloads, and starts the download (cold start supported)
  - Toast feedback: success "Magnet added — downloading…" or error "Couldn't add magnet: <reason>"
  - Protocol registration via `app.setAsDefaultProtocolClient('magnet')` (macOS/Windows)
  - Packaging declares `build.protocols.schemes: ["magnet"]` in `package.json`
- **Settings panel: Magnet Links section** — "Make default" button + status indicator
  - `systemSetDefaultMagnetHandler()` → {ok, isDefault}
  - `systemIsDefaultMagnetHandler()` → boolean
  - `systemConsumePendingMagnet()` → {magnet, error?}|null (pull-based catch-up for cold starts)
  - Event `system:magnet-received` → {magnet, error?} (push-based notification on magnet arrival)
- **Magnet URI parsing utilities** — `electron/lib/magnetLink.js`
  - `isMagnetUri(value)` — Check if string starts with "magnet:"
  - `parseMagnetFromArgv(argv)` — Extract first magnet URI from argv array (used for Windows/Linux first-launch and second-instance)
- **MagnetNavigator component** — Non-visual handler for magnet link events
  - Subscribes to `system:magnet-received` push event
  - Falls back to `systemConsumePendingMagnet()` pull on cold start (race-condition safe)
  - Deduplicates repeat deliveries (same magnet within 2 seconds)
  - Calls `onMagnet()` callback to switch renderer to Downloads view
- **Test coverage** — 10 new tests for magnet link parsing and argv extraction
  - Validates magnet URI detection
  - Tests parseMagnetFromArgv with real argv patterns (app exe, electron args, flags)
  - Rejects false positives (paths containing "magnet:", non-string values)

### Documentation
- **README.md** — Features section, new "Making Audiobook Library your default magnet app" usage subsection with platform-specific steps (macOS, Windows, manual alternative), Project Structure, Test count (0 → 98)
- **docs/api.md** — System IPC section with `system:setDefaultMagnetHandler`, `system:isDefaultMagnetHandler`, `system:consumePendingMagnet`, event `system:magnet-received`, and preload shortcuts

## [Phase 2]

### Added
- **Chapter menu** — Player bar chapter selection with jump-to-chapter support
  - Embedded chapters extracted from single-file audiobooks (m4b, m4a, mp3)
  - Multi-file books derive chapters from files (one per file)
  - Chapter data persisted in `book.chapters` field
- **Drag-and-drop import** — Drop files/folders on the window to import audiobooks
  - Intelligent grouping: per-directory books, loose-file grouping, or bulk import
  - Disc-aware bulk import: folders named CD1/CD2, Disc 1, Part 2, etc. merge into a single book with correct track ordering
  - `libraryImportPaths(paths)` IPC method with grouping rules
  - Import overlay shows "Importing…" while scanning
- **Settings view** — Sidebar settings panel to configure download directory
  - `settingsChooseDownloadDir()` for native folder picker
  - Existing and in-progress torrents retain original location; only new torrents use updated directory
- **Torrent persistence** — Active torrents survive app restart
  - Persisted to `userData/torrents.json` with state (paused, progress, download location)
  - .torrent files copied to `userData/torrents/` for re-adds after restart
  - Respects paused state across restarts; completed+imported torrents not re-added
- **Download performance** — Explicitly configured unlimited speed with up to 100 peer connections per torrent
- **Preload utilities** — `getPathForFile(file)` for File → path conversion (drag-and-drop support)
- **Test suite** — 87 Vitest unit tests covering
  - Byte-range parsing and media streaming
  - Import grouping logic (single books, multi-file, disc layouts)
  - Torrent persistence round-trips
  - Library CRUD operations
  - Natural sort order (A–Z by title/author)
- **Documentation** — Phase 2 features documented
  - IPC API reference (`docs/api.md`) with new channels and utilities
  - Data models (`docs/models.md`) with torrent persistence and chapter structures
  - Environment variables (`docs/env.md`)
  - Design system (`docs/design.md`)

## [0.1.0] — Initial Release

### Added
- Core audiobook library management
  - Add audiobooks via torrent downloads or local file import
  - User-defined genre organization with suggestions from metadata
  - Persistent library with JSON storage
- Built-in audio player
  - Play, pause, skip 30s, previous/next file
  - Playback position resume per book
  - Volume control
- Torrent downloading
  - Magnet URI support
  - `.torrent` file support
  - Pause, resume, remove torrents
  - Auto-import to library on completion
- Metadata scanning
  - Extract title, author, genre, duration from audio files
  - Cover art extraction and storage
  - Support for MP3, M4A, M4B, AAC, FLAC, OGG, Opus, WAV
- Design system
  - Dark theme with warm accent color
  - Responsive grid-based layout
  - Keyboard shortcuts (Space to play/pause, Escape to close menus)

### Technology Stack
- **Electron** 43.2 — Desktop framework
- **React** 19 + Vite — UI framework
- **webtorrent** 3.0 — Torrent client
- **music-metadata** 11.14 — Audio metadata reading
- **electron-builder** 26 — App packaging

---

**Note:** Earlier versions are not documented. This changelog begins with v0.1.0.
