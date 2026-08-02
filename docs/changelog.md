# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
- **README.md** — Features section, new "Making Audiobook Library your default magnet app" usage subsection with platform-specific steps (macOS, Windows, manual alternative), Project Structure, Test count (87 → 98)
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
