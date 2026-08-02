# Phase 2 — Chapters, easier import, persistence, settings, tests

Additions to docs/PLAN.md (which remains authoritative for everything not listed here).

## New/changed IPC contract
Invoke:
- `library:importPaths` `(paths: string[])` → imports dropped paths. Grouping rules:
  - a directory whose immediate children include audio files → one book from that dir (recursive audio collection)
  - a directory with NO direct audio but subdirectories that contain audio → one book per such subdirectory (bulk import) — EXCEPT: if ALL audio-bearing subdirectories look like disc/part folders (name matches `/^(cd|disc|disk|part)[\s._-]*\d+$/i`), the parent is ONE book (multi-disc layout, e.g. `Dune/CD1, CD2`), with files ordered by disc folder then natural file order
  - loose audio files in the same call → grouped as one book
  Returns `{ added: Book[], skipped: string[] }` (skipped = paths with no audio).
- `settings:chooseDownloadDir` `()` → native folder dialog; on pick, persists `downloadDir` and returns the new settings object; returns null if canceled. New torrents use the new dir; existing ones keep their paths.
- Preload additionally exposes `getPathForFile(file: File): string` implemented via `electron.webUtils.getPathForFile` (needed because sandboxed renderers can't read `File.path`).

## Data model additions (library.json — backward compatible, all optional)
- `book.chapters`: `[{ title, fileIndex, startSec }]` — only stored when embedded chapter markers are extracted (single-file m4b/m4a/mp3 via music-metadata, if the installed version exposes them; investigate `format`/`native` output — if music-metadata cannot provide chapters, store nothing and note it). Multi-file books do NOT store chapters; the renderer derives the chapter list from `files` (Chapter n = nth file, title from filename cleaned up).
- Existing books without the field must keep working untouched.

## Torrent persistence
- Persist active torrents to `userData/torrents.json` on add/remove/pause/resume and on quit: `[{ magnetOrInfoHash, torrentFileCopyPath?, downloadDir, paused, addedAt }]`. For .torrent-file adds, copy the .torrent into `userData/torrents/` so re-add works after restart.
- On app start, re-add all persisted non-done torrents (respecting saved paused state; a paused torrent re-adds then pauses). Completed+imported torrents are NOT re-added (library already has the book). webtorrent verifies existing partial data on disk automatically.

## Download speed
- No throttling exists and none may be added. Explicitly pass unlimited limits and raise `maxConns` (e.g. 100) on the WebTorrent client. Document in code comment.

## Settings UI (renderer)
- New Settings view (sidebar nav entry under Downloads): shows current download folder, "Change…" button → `settingsChooseDownloadDir`, note that existing torrents keep their old location.

## Chapter menu (renderer)
- Player bar gains a chapters button (list icon). Opens a popover/panel listing chapters: derived from `book.chapters` when present (jump = seek to startSec within fileIndex) else from `book.files` (jump = goToFile). Current chapter highlighted; position preserved behaviors unchanged.

## Drag & drop import (renderer)
- Dropping files/folders anywhere on the window shows a highlight overlay ("Drop to import"); on drop, map File objects → paths via `getPathForFile`, call `libraryImportPaths`, toast the result (n added / n skipped).

## Tests (qa)
- Vitest (`npm test`), tests/ dir. Targets: byte-range parsing (normal, suffix, malformed → 416, start≥size), media:// path gating (extension allowlist, covers-dir boundary incl. sibling-prefix bypass), naturalCompare ordering, library store CRUD + duplicate-id/import idempotency, importPaths grouping rules, torrents.json persistence round-trip (pure logic only — no live torrents).
- Backend must keep pure logic (range parsing, path gating, grouping, persistence serialization) in importable modules (extract from main.js into electron/lib/ as needed) so tests need no Electron runtime.
