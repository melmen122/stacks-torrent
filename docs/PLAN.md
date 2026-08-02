# Audiobook Torrent & Library — Build Plan

A local-only desktop app (Mac + Windows) that:
1. Downloads audiobooks via torrents (magnet links or .torrent files) — download-only, no torrent creation.
2. Stores them in a pleasing local library, organized into user-chosen genres (with suggestions from audio metadata).
3. Plays audiobooks with a built-in player that remembers playback position per book.

No cloud, no datacenters. All state lives in Electron's `app.getPath('userData')`.

## Stack
- **Electron** (main process, ESM) — real installable desktop app.
- **React 18 + Vite** — renderer UI. Dev: vite dev server + electron pointing at it. Prod: electron loads built `dist/index.html`.
- **webtorrent** (v2, ESM) — torrent download engine, runs in the main process.
- **music-metadata** — reads tags (title, author/artist, genre, duration) and embedded cover art from mp3/m4a/m4b/flac/ogg/opus.
- **electron-builder** — packaging: mac dmg + win nsis.

## Directory layout
```
package.json            (type: module; owned by BACKEND)
vite.config.js          (owned by BACKEND)
electron/
  main.js               (app lifecycle, window, protocol, IPC registration)
  preload.cjs           (contextBridge -> window.api, mirrors IPC contract)
  lib/library.js        (books + genres store, JSON persisted to userData/library.json)
  lib/torrents.js       (webtorrent client wrapper)
  lib/metadata.js       (music-metadata scan: tags, duration, cover extraction to userData/covers/)
src/renderer/           (owned by FRONTEND — React app, vite root)
  index.html
  ...components, styles
docs/design.md          (owned by FRONTEND — UI source of truth)
```

## Data model (library.json)
```jsonc
{
  "genres": [ { "id": "g1", "name": "Sci-Fi" } ],
  "books": [ {
    "id": "b1",
    "title": "Dune",
    "author": "Frank Herbert",
    "files": ["/abs/path/01.mp3", "..."],   // ordered audio files
    "coverPath": "/userData/covers/b1.jpg", // or null
    "durationSec": 75600,                    // total, may be null
    "genreId": "g1",                         // or null (Uncategorized)
    "suggestedGenre": "Science Fiction",     // from metadata, or null; cleared once user assigns
    "addedAt": 1721692800000,
    "position": { "fileIndex": 0, "seconds": 1234 } // playback resume
  } ]
}
```
Books land in the library either by finishing a torrent download or by importing an existing folder/files from disk.

## IPC contract (exact channel names; preload exposes camelCase methods on `window.api`)
Invoke (request/response):
- `library:list` → `{ books, genres }`
- `library:import` → opens native dialog (folder or audio files), scans metadata, adds book(s); returns added books
- `library:setGenre` `(bookId, genreId|null)` → updated book (also clears suggestedGenre)
- `library:removeBook` `(bookId, {deleteFiles:boolean})` → ok
- `genres:create` `(name)` → genre; `genres:rename` `(id,name)` → genre; `genres:delete` `(id)` → ok (books become uncategorized)
- `torrents:add` `(magnetUri | null)` → if null, open native .torrent file dialog; returns torrent summary `{infoHash,name}`
- `torrents:list` → `[{infoHash,name,progress,downloadSpeed,numPeers,done,paused}]`
- `torrents:pause` / `torrents:resume` / `torrents:remove` `(infoHash, {deleteFiles})`
- `player:savePosition` `(bookId, fileIndex, seconds)` → ok
- `settings:get` / `settings:set` — at minimum `downloadDir` (default `userData/downloads`)

Events (main → renderer via `webContents.send`):
- `torrents:progress` — throttled (~1s) array, same shape as `torrents:list`
- `torrents:done` — `{infoHash, name, bookId}` fired after auto-import into library
- `library:changed` — sent after any library mutation

Media serving: main registers `media://` protocol. Renderer uses `media://file/<urlencoded-abs-path>` for `<audio>` src and cover `<img>` src. Protocol must restrict to audio extensions + the covers dir (no arbitrary file read).

## Behaviors
- Torrent completes → scan its audio files → create book (grouped as one book per torrent) → set `suggestedGenre` from tags → notify renderer.
- Genre suggestion is only ever a suggestion; user accepts it (creates/assigns matching genre) or picks another; assignment always manual.
- Player: html `<audio>` in renderer, playlist = book.files in order, saves position every ~5s and on pause/switch; reopening a book resumes.
- Multi-file books: auto-advance to next file.

## npm scripts
- `dev` — vite dev server + electron (wait-on port)
- `build` — vite build
- `dist:mac` / `dist:win` — electron-builder targets
