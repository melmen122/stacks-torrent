# Data Models

## Library Persistence

The library is persisted as `library.json` in Electron's user data directory (platform-specific):
- **macOS:** `~/Library/Application Support/Audiobook Library/library.json`
- **Windows:** `%AppData%\Audiobook Library\library.json`

## Genre

A user-defined category for organizing books.

```typescript
interface Genre {
  id: string;       // Format: "g" + hex string (e.g., "g1f2e3d4c5b6a7890")
  name: string;     // User-facing name (e.g., "Science Fiction")
}
```

## Book

Represents an audiobook in the library. Audio files and optional cover art are stored on disk; metadata is persisted in `library.json`.

```typescript
interface Book {
  id: string;              // Format: "b" + hex string
  title: string;           // Extracted from audio metadata or folder name
  author: string;          // Extracted from audio metadata (artist/composer tag)
  files: string[];         // Absolute paths to audio files, ordered
  coverPath: string | null;// Absolute path to extracted/imported cover image, or null
  durationSec: number | null; // Total duration of all files combined, in seconds
  genreId: string | null;  // ID of assigned genre, or null (uncategorized)
  suggestedGenre: string | null; // Genre name from metadata; cleared when user assigns a genre
  addedAt: number;         // Unix timestamp (milliseconds) when book was added
  chapters?: Chapter[];     // Embedded chapters from audio metadata (single-file books only); optional
  position: {              // Current playback position
    fileIndex: number;     // Index in the files array
    seconds: number;       // Elapsed time in current file
  };
  scan?: {                 // VirusTotal scan state (optional; absent or null = unscanned)
    state: 'unscanned' | 'scanning' | 'done' | 'error';
    verdict: 'clean' | 'suspicious' | 'infected' | 'unknown' | null;
    scannedAt: number | null;    // Unix timestamp (milliseconds) when scan completed
    files: [{
      name: string;               // Audio file name
      sha256: string;             // File hash
      verdict: 'clean' | 'suspicious' | 'infected' | 'unknown' | null;
      malicious: number | null;   // Count of engines flagging as malicious
      suspicious: number | null   // Count of engines flagging as suspicious
    }]
  };
  source?: TorrentSource | ImportSource | null; // Provenance, set once at import time; null/absent = legacy book (added before this field existed)
}
```

### Source (provenance)

Set once, at import time, and never mutated afterward — it survives the source torrent later being removed (it's a historical record, not a live reference). `null`/absent means either a legacy book (added before this field existed) or that no report was available at import time; the renderer must treat that the same as "unknown provenance", not as "unsafe".

This is the only genuine, positive safety signal available for most audiobooks: VirusTotal (layer 2, `Book.scan`) returns `'unknown'` for essentially every personal rip, since audiobooks are almost never present in VirusTotal's database. Layer 1 — did the torrent's manifest contain any executables/archives/disguised files bundled alongside the audio, and were they kept off disk — is what `source.safety` records.

```typescript
interface TorrentSource {
  type: 'torrent';
  infoHash: string;        // The originating torrent's info hash (independent of whether that torrent still exists)
  safety: {
    verdict: 'clean' | 'caution' | 'danger';  // classifyTorrentFiles' verdict at import time (see safetyCheck.js)
    hasAudio: boolean;
    skippedCount: number;   // Full count of non-audio files that were NOT downloaded (uncapped)
    skipped: [{              // Detail list, capped to the first 50 entries (MAX_SOURCE_SKIPPED_ENTRIES in bookSource.js) so a pathological torrent can't bloat library.json
      name: string;
      category: 'executable' | 'disguised' | 'archive' | 'companion' | 'other';
      reason: string;
    }]
  };
  importedAt: number;       // Unix timestamp (milliseconds)
}

interface ImportSource {
  type: 'import';           // Added via manual import / drag & drop — no manifest to classify, so no safety verdict is invented
  importedAt: number;       // Unix timestamp (milliseconds)
}
```

### Chapters

Chapter data is extracted from single-file audiobooks (m4b, m4a, mp3) when the audio metadata contains chapter markers. Multi-file books do not store chapters; the UI derives a chapter list from the files array instead.

```typescript
interface Chapter {
  title: string;      // Chapter name from metadata
  fileIndex: number;  // Which file this chapter belongs to (0 for single-file books)
  startSec: number;   // Time offset in seconds within that file
}
```

### Cover Art

Book cover art is extracted during metadata scanning to `userData/covers/`. Files are named by book ID:
- `covers/{bookId}.jpg` — JPEG extracted from audio metadata
- `covers/{bookId}.png` — PNG extracted from audio metadata

If no embedded art is found, the book renders with a deterministic two-color gradient (seeded by title+author).

### Suggested Genre

When metadata tags include a genre, it's stored in `suggestedGenre`. The UI displays this as a dismissible pill. Accepting it:
1. Creates the genre if it doesn't already exist (case-insensitive match)
2. Assigns the book to that genre
3. Clears the suggestion

Rejecting simply clears `suggestedGenre`.

## Torrent

### Runtime Representation

An in-flight or completed torrent download is returned by the torrent manager API:

```typescript
interface Torrent {
  infoHash: string;      // SHA-1 hash of torrent metadata (unique identifier)
  name: string;          // Torrent name from metadata
  progress: number;      // Fraction of bytes downloaded (0–1, may be > 1 if seeding)
  downloadSpeed: number; // Bytes per second
  numPeers: number;      // Connected peers
  done: boolean;         // Download complete
  paused: boolean;       // User has paused this torrent
  discovery: 'searching' | 'no-peers' | 'connected'; // Peer-discovery status (see api.md)
}
```

### Persistence

Active torrents are persisted to `userData/torrents.json` and restored on app restart (respecting paused state). Completed torrents are NOT re-added if they were already imported into the library.

```typescript
interface PersistedTorrent {
  magnetOrInfoHash: string;           // Magnet URI or info hash (for re-adding)
  torrentFileCopyPath?: string;       // Path to .torrent file copy in userData/torrents/ (if added from file)
  downloadDir: string;                // Absolute path where this torrent downloads
  paused: boolean;                    // Whether the torrent was paused at shutdown
  addedAt: number;                    // Unix timestamp (milliseconds) when added
  imported?: boolean;                 // Whether this torrent was already imported to library (prevents re-adding completed torrents)
}
```

When a `.torrent` file is added, the file is copied to `userData/torrents/` so that re-adds work after restart without the original file.

### Auto-Import on Completion

When a torrent finishes:
1. Audio files are scanned for metadata (title, author, genre, duration, cover art)
2. A new `Book` is created with a deterministic ID: `"b" + first 16 chars of infoHash`
3. Cover art is extracted to `userData/covers/`
4. The book is added to the library
5. A `torrents:done` event is fired with `{ infoHash, name, bookId }`

If a book with that deterministic ID already exists (e.g., re-importing the same torrent), it's silently skipped to prevent duplicates.

## Settings

Application configuration persisted to `settings.json` in the user data directory.

```typescript
interface Settings {
  downloadDir: string;              // Absolute path where torrents download (default: userData/downloads)
  virusTotalApiKey?: string | null; // VirusTotal API key (optional; null = disabled)
  virusTotalEnabled?: boolean;      // Whether VirusTotal scanning is enabled (default: false)
  phoneServerEnabled?: boolean;     // Whether the phone server is enabled (default: false)
  phoneServerPort?: number;         // Phone server listening port (default: 8787, valid: 1024–65535)
  phoneServerPin?: string | null;   // Current 6-digit PIN (null until first enable)
  phoneServerSecret?: string | null;// Secret for session token HMAC (null until first enable)
}
```

**VirusTotal API Key Handling:**
- The API key is stored in plaintext in `settings.json` on disk (acceptable for a personal local app).
- The key is NEVER logged, never sent to the renderer process, and never included in error messages.
- Setting the key to `null` disables VirusTotal scanning.

**Phone Server PIN and Secret Handling:**
- Generated automatically on first enable (random 6-digit PIN and random 32-byte hex secret).
- Persisted to `settings.json` so sessions survive an app restart.
- Regenerating the PIN invalidates all existing sessions (new secret means all previously-issued session cookies no longer match the HMAC).
- Never logged or sent to the renderer; only the PIN (not the secret) is displayed in the UI for user entry on the phone.

## Playback Resume

The renderer maintains an in-session cache (`PlayerContext`) of playback positions, updated whenever playback is saved (roughly every 5 seconds, on pause, on file change, or when closing the player). This cache takes priority over the persisted `book.position` to ensure in-session changes are never lost to a stale fetch.

If a book is removed from the library while it's playing, playback stops and position saves are skipped.

---

## VirusTotal Cache

Hash lookups are cached locally to avoid repeated API calls.

```typescript
interface VirusTotalCacheEntry {
  verdict: 'clean' | 'suspicious' | 'infected' | 'unknown';
  malicious?: number;     // Count of engines flagging as malicious (when known)
  suspicious?: number;    // Count of engines flagging as suspicious (when known)
  checkedAt: number;      // Unix timestamp (milliseconds) when hash was looked up
}

// Stored as userData/vt-cache.json:
{
  "[sha256-hex]": { verdict, malicious, suspicious, checkedAt },
  // ... one entry per scanned file
}
```

**Cache TTL:** Entries are re-checked after 30 days to catch new detections. Unknown verdicts are rechecked sooner.

## File Organization

```
userData/
  library.json          # Books and genres (JSON)
  settings.json         # User settings (download dir, VirusTotal API key)
  torrents.json         # Persisted torrent list (re-added on startup)
  vt-cache.json         # VirusTotal hash cache (sha256 → verdict, TTL 30d)
  covers/               # Extracted cover images
    b1f2e3d4...jpg
    b5c6a7b8...png
  torrents/             # Archived .torrent files (for re-adds after restart)
    [filename].torrent
  downloads/            # Torrent download directory (default; can be changed)
    [torrent contents]
```

Where `userData` is:
- **macOS:** `~/Library/Application Support/Audiobook Library/`
- **Windows:** `%AppData%\Audiobook Library\`
- **Linux:** `~/.config/Audiobook Library/`
