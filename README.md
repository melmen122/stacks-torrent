# Audiobook Library

A local-only Electron desktop app (Mac + Windows) for downloading audiobooks via torrents, organizing them into genres, and playing them with a built-in player that remembers your position. All state stays on your machine—no cloud, no servers.

## Features

- **Torrent Downloads** — Add audiobooks via magnet links or `.torrent` files; watch download progress in real time.
- **Torrent Persistence** — In-progress downloads survive app restarts; active torrents resume automatically on launch, respecting paused state.
- **Auto-Library Import** — Completed torrents are scanned for metadata (title, author, genre, duration, cover art) and automatically added to your library.
- **Manual Import** — Import existing audiobook files or folders from disk into the library.
- **Drag & Drop Import** — Drop audio files or folders anywhere on the app window to import them instantly.
- **Genres & Organization** — Create custom genres and assign books to them. Metadata scanning suggests genres based on audio tags; accepting or rejecting suggestions is always manual.
- **Built-in Player** — Play audiobooks with familiar transport controls (play/pause, skip ±30s, next/previous file). Playback position is saved per book and restored when you reopen it.
- **Multi-file Books** — Audiobooks are grouped as single entities; the player auto-advances through files in order.
- **Placeholder Art** — Books without embedded cover art render with deterministic two-color gradients seeded by title and author, plus white initials.
- **Chapter Navigation** — For single-file audiobooks with embedded chapters (m4b, m4a, mp3), jump directly to any chapter via the player's chapter menu. Multi-file books derive chapters from files.
- **Settings** — Change the default download folder for new torrents; existing and in-progress downloads keep their original location. Set as default magnet link handler.
- **Set as Default Magnet Handler** — Clicking a magnet link in your browser or file manager opens Audiobook Library and starts the download. One-click registration from Settings.
- **Search & Sort** — Filter library by title/author; sort by recently added, title A–Z, or author A–Z.
- **Safety Features** — Two complementary layers protect against malicious files: local pre-download filtering blocks executables and archives before they ever touch disk, while optional VirusTotal scanning provides post-download verification via file hashes (see **Safety** section below).

## Safety

**Two complementary layers protect your library:**

### Layer 1 — Pre-Download Safety Check (Always On, Local Only)

Before any file content downloads, the app inspects the torrent's file manifest and downloads **only audio files** (plus small cover images ≤5MB). Executables (`.exe`, `.scr`, `.bat`, `.msi`, `.cmd`, `.com`, `.vbs`, `.ps1`, `.app`, `.dmg`, `.deb`, `.rpm`, `.sh`, and ~50 others), disguised files (e.g. `Chapter 1.mp3.exe`), archives (`.zip`, `.rar`, `.7z`, `.tar`, `.gz`, etc.), and unrecognized files are never requested from peers.

**How it works:**
- Filename tricks are normalized first (trailing dots/spaces, Unicode right-to-left overrides)
- Works identically for magnet links and `.torrent` files
- Each torrent row shows a safety badge: ✓ clean / ⚠ caution / ⛔ danger
- Click the badge to see a list of all skipped files and why
- If a torrent contains no audio at all, nothing downloads and the row warns you
- After download completes, any stray bytes of skipped files are automatically deleted

**Important:** This layer cannot detect malware *inside* a valid audio file—a malicious `.mp3` still shows "clean". That's what Layer 2 is for. Neither layer is a replacement for your OS antivirus (Windows Defender / macOS protections).

### Layer 2 — VirusTotal Scanning (Opt-in, Requires Free API Key)

After a book downloads, each audio file is SHA-256 hashed and the hash is looked up in VirusTotal's database. Hashes only—file contents are never uploaded.

**Setup:**
1. Sign up for a free VirusTotal account at [virustotal.com](https://www.virustotal.com)
2. Copy your API key
3. In Settings → "Virus scanning (VirusTotal)", paste your key (stored locally in `settings.json`, never sent to the renderer or logged)

**How it works:**
- Disabled by default; enabled when you supply an API key
- After download, each audio file is automatically scanned in the background
- Results per book: ✓ clean / ⚠ suspicious / ⛔ infected / unknown (neutral—not a safety signal)
- Free tier is rate-limited to 4 lookups/minute, so a 199-file audiobook takes ~50 minutes
- Scanning never blocks playback or the library
- Results are cached locally (30-day TTL), so re-scans are instant
- Manually scan any book via the book's menu → "Scan for viruses" / "Re-scan for viruses"
- On app launch, previously-unscanned books are queued automatically

**Important:**
- VirusTotal cannot scan before downloading (no file = no hash). The app does *not* scan torrents before accepting them.
- **"Unknown" results (the norm for audiobooks):** VirusTotal has likely never seen this file. This is entirely normal for audiobooks—personal rips are almost never uploaded to VirusTotal. "Unknown" is neither a safety signal nor reassurance; it simply means no known threats. Audiobooks are safe to play even if VirusTotal returns "unknown" for every file.
- This feature contacts an external service (hashes leave your machine); Layer 1 is entirely local.
- Still not a replacement for OS antivirus.

### Torrent Stuck or Hung?

If a torrent sits at `0%` with `0 peers` for an extended time, the torrent's metadata may still be arriving, or the swarm may be dead (seeders offline or trackers defunct). The Downloads view shows your status:

- **"Searching for peers…"** — Metadata is arriving and the app is looking for peers. Normal, give it ~2 minutes.
- **"No peers found…"** — The app has waited ~2 minutes and found no seeders or leechers. The torrent swarm may be genuinely dead, or seeders may come online later. The download will resume automatically if a peer appears.

Nothing is ever auto-removed or auto-paused. Paused downloads never show a "no peers" message, only active downloads.

### Provenance Badge — Know Your Audiobook's Origin

When a book is imported from a torrent download, the app displays its provenance (Layer 1 safety verdict) on the library card:

- **✓ Audio-only download** — The torrent contained only audio files; no executables, archives, or risky companions were present.
- **✓ Audio only — N risky file(s) skipped** — Audio-only, but the original torrent bundled suspicious files (e.g., `.exe`, `.zip`). Click the badge to see the list. The risky files never touched disk.
- **No badge** — The book was imported manually from disk, or was added before this feature rolled out. The app has no record of how it arrived and makes no safety claim.

Books added before this update won't show a provenance badge—absence of a badge means "we don't know," never "we checked and it's fine."

## Requirements

- **Node.js** 20 or later
- **npm** 10 or later
- **macOS** 10.13+ (Intel or Apple Silicon) or **Windows** 10+ for running packaged apps

## Getting Started

### Development

```bash
git clone <repo>
cd audio_book_torrent
npm install
npm run dev
```

This starts a Vite dev server on port 5173 and launches Electron, pointing to it. The app will hot-reload as you edit renderer code.

### Production Build

```bash
npm run build
```

This bundles the React frontend into `dist/`. To create a packaged installer:

```bash
npm run dist:mac    # macOS DMG (run on macOS)
npm run dist:win    # Windows NSIS installer (run on Windows)
```

### Building on Windows

Building on Windows is recommended over cross-building from macOS.

**Prerequisites:**

- **Node.js** 20 LTS ([nodejs.org](https://nodejs.org/))
- **Git** ([git-scm.com](https://git-scm.com/))
- **No Visual Studio or C++ build tools required** — all native dependencies ship prebuilt N-API binaries (ABI-stable across Node.js and Electron versions), so `npm install` fetches pre-compiled modules instead of building from source.

**Steps:**

Clone the repository:

```bash
git clone https://github.com/melmen122/stacks-torrent.git
```

Enter the directory:

```bash
cd stacks-torrent
```

Install dependencies:

```bash
npm install
```

This downloads and installs all dependencies, including prebuilt native modules. Yellow warnings are normal; errors indicate a problem.

Build the installer:

```bash
npm run dist:win
```

**Output and Installation**

The installer appears at `release\Audiobook Library-0.1.0-x64.exe`. Double-click to install.

**SmartScreen Warning**

Since the app is unsigned, Windows SmartScreen may warn on first run. Click **More info**, then **Run anyway** to proceed.

**Data Storage**

Audiobook Library stores its library, settings, downloads, and metadata at `%AppData%\Audiobook Library\`. The Windows library is independent from macOS (no cloud sync by design).

**Cross-platform Builds**

To build for Windows on macOS, see the [electron-builder multi-platform build guide](https://www.electron.build/multi-platform-build) for Wine or WSL setup.

**Native Module Requirement**

The build config sets `npmRebuild: false`, which skips electron-builder's native rebuild step. This is safe *only* because all native dependencies in this project (bufferutil, utf-8-validate, utp-native, node-datachannel, fs-native-extensions) ship N-API prebuilt binaries. N-API is ABI-stable, so the prebuilt binaries work correctly in Electron without recompilation.

**Important invariant for contributors:** Any new native dependency must also ship N-API (or prebuildify) prebuilt binaries. A NAN or V8-ABI module will not work under `npmRebuild: false`—it will build and bundle silently but fail at runtime with a `NODE_MODULE_VERSION` mismatch error, not a build-time error. Before adding a native dependency, verify that it provides N-API prebuilds (check `package.json`'s `engines` and `binary` fields, or the GitHub readme).

Torrent transport in this app relies on both TCP and uTP (`utp-native`), so `WebTorrent.UTP_SUPPORT` should be `true` in a correct build.

### Standalone Launch

After building, run the packaged app:

```bash
npm start
```

This assumes you've already run `npm run build`; it loads Electron with the bundled `dist/index.html`.

## Usage

### Adding Audiobooks

**Via Torrent (Downloads View):**
1. Click the **Downloads** tab in the sidebar.
2. Paste a magnet link and click **Add**, or click **Open .torrent file…** to select a `.torrent` file.
3. The download begins immediately. Progress, speed, and peer count update live.
4. When complete, the app scans the torrent's audio files, extracts metadata (title, author, genre, cover art), and automatically imports them into your library as a single book.
5. A toast notification confirms the import; the book appears in the **Library** tab.

**Via File Import (Library View):**
1. Click **Import books…** in the toolbar.
2. Choose a folder containing audio files, or select individual audio files. On macOS, you can do both at once; on Windows and Linux, you're prompted to pick folder or files first.
3. Selected folders are scanned recursively for audio files. Each subfolder normally becomes one book. **Exception:** Disc-style layouts (subfolders named CD1/CD2, Disc 1, Disc 2, Part 1, Part 2, etc.) are recognized and imported as a single book with correct track ordering.
4. Metadata is scanned, cover art extracted, and books added to the library.

**Via Drag & Drop:**
Simply drag audiobook folders or individual audio files onto the app window to import them. An overlay shows "Importing…" while the import runs (concurrent imports are not allowed). Grouping follows the same rules as file import: folders become individual books, loose files are grouped together, and disc-style layouts (CD1/CD2, Disc 1, etc.) merge into a single book with correct track ordering.

### Organizing with Genres

1. In the **Genres** section of the sidebar, click the **+** button to create a new genre.
2. Type a name and press Enter.
3. In the library grid, hover over a book and click the **⋯** menu, then select a genre to assign it.
4. If the audiobook's metadata includes a genre, a suggestion pill appears on the card. Click **✓** to accept (creates the genre if it doesn't exist) or **✕** to dismiss.

### Playing Audiobooks

1. In the library grid, hover over a book and click the **▶** play icon.
2. The player bar appears at the bottom with transport controls:
   - **Play/Pause** — Space bar or the button
   - **±30s** — Jump forward or back 30 seconds
   - **Next/Previous** — Skip to the next or previous file (multi-file books only)
   - **Chapters** — For books with embedded chapters (m4b, m4a, mp3), click the chapter menu to jump to a specific chapter; multi-file books list each file as a chapter
   - **Seek bar** — Click to jump to a specific position; drag to scrub
   - **Volume slider** — Adjust playback volume
3. Your position is saved automatically every ~5 seconds, on pause, when switching files, and when closing the player.
4. Reopening the same book resumes from where you left off.

### Search & Filter

Use the search box in the toolbar to filter by title or author. Sort by recently added, title A–Z, or author A–Z.

### Settings

Click the **⚙️** icon in the sidebar to open settings and:
- **Change Download Directory** — Select where torrents download by default. This affects new torrents only; existing and in-progress torrents keep their original location.
- **Magnet Links** — Click "Make default" to register Audiobook Library as the handler for magnet links. See "Making Audiobook Library your default magnet app" below for platform-specific steps.

### Making Audiobook Library your default magnet app

**Note:** Registering the app does NOT automatically take over from an existing client (e.g., uTorrent). You must complete a one-time manual step on your OS.

**macOS:**
1. Launch Audiobook Library at least once.
2. Open Settings and click **Make default** in the "Magnet Links" section.
3. macOS may show an "Open with" confirmation the first time you click a magnet link. Select Audiobook Library.
4. If another torrent client (e.g., uTorrent) keeps intercepting magnet links, disable its "check if default at startup" option in its preferences, since it re-registers itself on launch.

**Windows:**
1. Launch Audiobook Library at least once.
2. Open Settings and click **Make default** in the "Magnet Links" section. This writes the registry key.
3. When you click a magnet link, Windows shows a protocol chooser. Select Audiobook Library.

**Alternative (no registration needed):**
If you don't want to change your default magnet handler, you can copy a magnet link into the Downloads view manually:
1. Copy the magnet link from your browser or file manager.
2. Switch to Audiobook Library, click the **Downloads** tab.
3. Paste the link and click **Add**.

## Where Data Lives

All files are stored in Electron's platform-specific `userData` directory. No cloud sync.

- **macOS:** `~/Library/Application Support/Audiobook Library/`
- **Windows:** `%AppData%\Audiobook Library\`
- **Linux:** `~/.config/Audiobook Library/`

Within that directory:

```
userData/
  library.json          # Books and genres (JSON)
  settings.json         # User settings (download directory, VirusTotal API key)
  torrents.json         # In-progress torrent state (persistence)
  vt-cache.json         # VirusTotal scan results cache (hash → verdict, TTL 30 days)
  covers/               # Extracted cover images
    {bookId}.jpg or .png
  downloads/            # Torrent downloads (default location)
    [torrent contents]
  torrents/             # Copied .torrent files for active downloads
    [.torrent files]
```

## Known Limitations

1. **Import Dialog Behavior on Windows/Linux** — Native file dialogs on Windows and Linux cannot combine folder and file selection in a single dialog. The app asks whether you want to import a folder or individual files, then shows the appropriate picker.

2. **File Deletion on Book Removal** — When you remove a book from the library and elect to delete its files, the audio files and the app's extracted cover image are deleted, and the book's folder is removed if it ends up empty. Non-audio leftovers inside the torrent folder (e.g., `cover.jpg`, `.nfo`, PDFs, `.m3u` playlists) are not deleted — clean those up manually if desired.

## Project Structure

```
package.json                      # Dependencies, build config
vite.config.js                    # Vite config (React bundler)
scripts/
  start-dev.cjs                   # Dev server launcher (starts Vite + Electron)

electron/
  main.js                         # App lifecycle, window, media:// protocol, IPC, magnet handler
  preload.cjs                     # Context bridge; exposes window.api
  lib/
    library.js                    # Book & genre store (library.json)
    torrents.js                   # WebTorrent client wrapper
    metadata.js                   # Metadata scanning (music-metadata)
    importGrouping.js             # Multi-file book grouping logic (incl. disc layouts)
    mediaRange.js                 # HTTP Range request handling for media streaming
    mediaGate.js                  # media:// protocol security & Range support
    torrentPersistence.js         # Save/restore torrent state across restarts
    magnetLink.js                 # Magnet URI parsing helpers (isMagnetUri, parseMagnetFromArgv)
    safetyCheck.js                # Pre-download safety classification (audio-only filtering)
    virusTotal.js                 # VirusTotal API wrapper (hash lookup, verdict mapping)
    scanQueue.js                  # Rate-limited scan queue with caching (4 req/min, 30d TTL)
    virusTotalCache.js            # Local cache persistence (vt-cache.json)
    virusTotalScanner.js          # Hash calculation & background scanning orchestration

src/renderer/
  index.html                      # Entry point
  main.jsx                        # React root
  App.jsx                         # Main layout
  api.js                          # IPC helper (calls window.api)
  components/
    Sidebar, LibraryView, DownloadsView, PlayerBar, BookCard
    ChapterMenu.jsx               # Chapter selection popover
    SettingsView.jsx              # Settings panel (download directory, magnet handler, VirusTotal key)
    DropImportOverlay.jsx         # Drag & drop import UI
    MagnetNavigator.jsx           # Non-visual magnet link handler (cold-start + warm-path)
    SafetyBadge.jsx               # Pre-download safety verdict badge (clean/caution/danger)
    SafetyDetails.jsx             # Detailed report: skipped files & reasons (popover/expand)
    ScanBadge.jsx                 # VirusTotal scan status badge (scanning/clean/suspicious/infected/unknown)
    VirusTotalContext.jsx         # VirusTotal API wrapper & state management
    [other components]
  context/
    LibraryContext, PlayerContext, TorrentsContext, ToastContext, VirusTotalContext
  styles/
    variables.css                 # Palette, spacing, typography
    *.css                         # Component-scoped styles
  utils/
    color.js                      # Gradient & initials for placeholder art
    format.js                     # Time & file size formatting
    media.js                      # media:// URL builder

tests/
  *.test.js                       # Vitest unit tests (byte-range, grouping, persistence, etc.)
  vitest.config.js                # Test runner config

docs/
  PLAN.md                         # Build spec (accurate; do not edit)
  design.md                       # UI design system (accurate; do not edit)
  models.md                       # Data model (accurate; do not edit)
  api.md                          # IPC API reference (accurate; do not edit)
  env.md                          # Environment variables (accurate; do not edit)
  changelog.md                    # Version history
```

## Testing

The app includes a comprehensive test suite covering core functionality:

```bash
npm test
```

Runs 231 Vitest unit tests in the `tests/` directory, including:
- Pre-download safety classification (audio-only, executables, disguised files, archives, counts, verdicts)
- VirusTotal response parsing (200/404/401/429, verdict mapping, cache TTL, rate limiting)
- Magnet URI parsing (isMagnetUri, parseMagnetFromArgv)
- Byte-range parsing for media streaming (seek without buffering)
- Import grouping logic (single books, multi-file books, disc layouts)
- Torrent persistence (save/restore state across restarts)
- Library CRUD operations
- Natural sort order (A–Z by title/author)

## How It Works

### Architecture

**Main Process (Electron)** — Owns the `library.json` and `settings.json` files, runs the WebTorrent client, scans metadata, and manages downloads. Registers a `media://` protocol to stream audio files and cover images locally.

**Renderer (React)** — Displays the UI, handles user interactions (search, genre creation, playback), and talks to the main process over IPC. All rendering libraries (book cards, torrent rows) are driven by live state from IPC events.

### Data Flow

1. **Torrent Download:** WebTorrent client (main process) downloads in the background, broadcasting progress every ~1 second.
2. **Completion:** When done, the main process scans audio files for metadata (title, author, genre, duration, cover art), creates a `Book` entry, and broadcasts a `torrents:done` event.
3. **Playback:** Renderer plays audio via an `<audio>` element sourced from `media://file/{path}`. The player saves position every ~5s to the main process, which persists it to `library.json`.
4. **IPC Events:** Main process broadcasts library changes (`library:changed`) and torrent progress (`torrents:progress`) to the renderer, which refetches data and updates live.

### Media Streaming

Audio files and cover images are served via a custom `media://` protocol. This avoids file-URI security sandbox issues and enables Range request support for seeking without buffering the entire file.

## Legal

**Only download and share audiobook content you have the rights to distribute.** Respect copyright and author rights.

---

Built with Electron, React, WebTorrent, and music-metadata.
